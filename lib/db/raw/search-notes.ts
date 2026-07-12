/**
 * Full-text note search over the generated `search_tsv` column.
 *
 * Query text goes through `websearch_to_tsquery` (never raw `to_tsquery`
 * on user text, which throws on arbitrary input), falling back to
 * `plainto_tsquery` when websearch parsing yields an empty query.
 * Pure-negation queries (`querytree` = `'T'`, e.g. `-draft`) match
 * nothing instead of every note lacking the term.
 *
 * Type-ahead: the last term additionally matches as a prefix so a
 * partial word surfaces hits while the user types (`auth` finds
 * `Authorization`). The parsed query is OR-composed with a prefix arm
 * built by {@link typeaheadArm}: OR keeps full-word ranking dominant,
 * while ANDing the head terms into the prefix arm preserves multi-word
 * semantics (`note lin` still requires the `note` concept, matched
 * against `lin` as a prefix). Plain OR of the bare prefix would let the
 * partial last word alone match; plain AND of the full parse would
 * demand the partial word as a complete lexeme and kill type-ahead.
 * A hyphenated or otherwise punctuated last term splits into its
 * alphanumeric sub-tokens, ANDed together with only the final sub-token
 * prefix-matched (`probe-card` becomes `probe & card:*`), so it matches
 * a compound like `probe-cardinality` that Postgres tokenizes into
 * separate lexemes. Each sub-token is strict alphanumerics and the `&`
 * and `:*` operators are inserted here, so no user text ever reaches
 * `to_tsquery` syntax. GIN `tsvector_ops` supports prefix lexemes via
 * partial match, so the arm stays on `notes_search_idx`.
 *
 * Ranked on the GIN index and capped at `NOTE_SEARCH_LIMIT`; the raw
 * `body` and `search_tsv` are never selected.
 */

import { sql } from "drizzle-orm";
import { notes, projects } from "@/lib/db/schema";
import { type ReadConn } from "@/lib/db/raw";

/** Maximum hits one search returns. */
const NOTE_SEARCH_LIMIT = 20;

/** Row shape returned by the note search query. */
export type NoteSearchRawRow = {
  id: string;
  slug: string;
  sequence_number: number;
  title: string;
  type: string;
  folder: string;
  summary: string;
  visibility: string;
  feed_mode: string;
  agent_writable: boolean;
  locked: boolean;
  updated_at: string | Date;
  rank: number;
};

/**
 * Build the type-ahead prefix arm for a query's last term.
 *
 * The arm is skipped when the query ends with a quote (the user closed
 * a phrase), when the last term is websearch-negated (`-draft` must not
 * prefix-match `draft`), or when the final alphanumeric sub-token is
 * fewer than 2 chars (a 1-char prefix matches too much).
 *
 * @param query - Trimmed, non-empty user search text.
 * @returns The query text before the last term plus the ANDed sub-token
 *   prefix expression (final sub-token as `token:*`), or `null` when the
 *   arm does not apply.
 */
function typeaheadArm(query: string): { head: string; prefix: string } | null {
  if (query.endsWith('"')) return null;
  const start = query.search(/\S+$/);
  const lastTerm = query.slice(start);
  if (lastTerm.startsWith("-")) return null;
  const subTokens = lastTerm.split(/[^a-zA-Z0-9]+/).filter((t) => t.length > 0);
  const lastSub = subTokens.at(-1);
  if (lastSub === undefined || lastSub.length < 2) return null;
  const prefix = subTokens
    .map((token, i) => (i === subTokens.length - 1 ? `${token}:*` : token))
    .join(" & ");
  return { head: query.slice(0, start).trim(), prefix };
}

/**
 * The ranked note search as a lazy batch statement. Batch alongside
 * `projectAccessGateStmt` and evaluate the gate rows first.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project to search in.
 * @param query - Trimmed, non-empty user search text.
 * @returns Lazy raw statement yielding {@link NoteSearchRawRow}s.
 */
export function noteSearchStmt(
  read: ReadConn,
  projectId: string,
  query: string,
) {
  const arm = typeaheadArm(query);
  const prefixExpr =
    arm === null
      ? sql``
      : arm.head === ""
        ? sql` || to_tsquery('english', ${arm.prefix})`
        : sql` || (websearch_to_tsquery('english', ${arm.head}) && to_tsquery('english', ${arm.prefix}))`;
  return read.execute(sql`
    WITH q AS (
      SELECT (CASE
        WHEN numnode(websearch_to_tsquery('english', ${query})) = 0
          THEN plainto_tsquery('english', ${query})
        ELSE websearch_to_tsquery('english', ${query})
      END)${prefixExpr} AS tsq
    )
    SELECT n.id, n.slug, n.sequence_number, n.title, n.type, n.folder,
           n.summary, n.visibility, n.feed_mode, n.agent_writable, n.locked,
           n.updated_at, ts_rank(n.search_tsv, q.tsq) AS rank
    FROM q, ${notes} n
    WHERE n.project_id = ${projectId}
      AND n.deleted_at IS NULL
      AND querytree(q.tsq) <> 'T'
      AND n.search_tsv @@ q.tsq
    ORDER BY rank DESC, n.updated_at DESC
    LIMIT ${NOTE_SEARCH_LIMIT}
  `);
}

/**
 * Resolve a typed note ref to a single live note, bypassing FTS.
 *
 * A note ref (`PREFIX-N<seq>`) is composed at read time and never enters
 * the `search_tsv`, so {@link noteSearchStmt} can never match it. This
 * sibling resolves the ref by exact project identifier + sequence number,
 * gated to the searched project so a ref naming any other project matches
 * nothing here (the caller then falls back to {@link noteSearchStmt}, so
 * ref-shaped title text stays findable). Returns the identical slim
 * {@link NoteSearchRawRow} shape (no `body`, no `search_tsv`) with a
 * constant rank, and stays inside the caller's RLS scope like the FTS path.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project to search in.
 * @param prefix - Uppercased ref prefix; must equal the project identifier.
 * @param seq - Parsed note sequence number.
 * @returns Lazy raw statement yielding at most one {@link NoteSearchRawRow}.
 */
export function noteRefSearchStmt(
  read: ReadConn,
  projectId: string,
  prefix: string,
  seq: number,
) {
  return read.execute(sql`
    SELECT n.id, n.slug, n.sequence_number, n.title, n.type, n.folder,
           n.summary, n.visibility, n.feed_mode, n.agent_writable, n.locked,
           n.updated_at, 1 AS rank
    FROM ${notes} n
    JOIN ${projects} p ON p.id = n.project_id
    WHERE n.project_id = ${projectId}
      AND p.identifier = ${prefix}
      AND n.sequence_number = ${seq}
      AND n.deleted_at IS NULL
    LIMIT 1
  `);
}

/** Rows a ref-fragment scan may return before the caller merges text hits. */
const REF_FRAGMENT_LIMIT = 20;

/**
 * Escape the LIKE metacharacters in a user fragment so `%` and `_` match
 * themselves rather than acting as wildcards.
 *
 * @param fragment - Raw user text.
 * @returns Fragment safe to wrap in `%...%`, escaping on backslash.
 */
function escapeLike(fragment: string): string {
  return fragment.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Match notes in the searched project whose composed ref contains the
 * fragment, the way the task list filters on its `taskRef` substring: `1`
 * finds `N1`, `N11`, and `N111`; `N1` and the project prefix do the same.
 * The ref is composed at read time and never enters `search_tsv`, so the FTS
 * path can never match it.
 *
 * The caller merges these ahead of the text hits rather than letting them
 * win outright: a fragment is also ordinary search text. Only a whole-ref
 * query short-circuits, through {@link noteRefSearchStmt}.
 *
 * The composed predicate is not indexable, so this scans the project's live
 * notes. It stays a separate statement rather than an `OR` arm on
 * {@link noteSearchStmt} precisely so the FTS query keeps using its GIN
 * index, and it rides the caller's existing read batch, costing no round
 * trip. Bounded by {@link REF_FRAGMENT_LIMIT}.
 *
 * Returns the identical slim {@link NoteSearchRawRow} shape (no `body`, no
 * `search_tsv`) and stays inside the caller's RLS scope like the FTS path.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project to search in.
 * @param fragment - Non-empty, whitespace-free ref fragment.
 * @returns Lazy raw statement yielding up to {@link REF_FRAGMENT_LIMIT} rows,
 *   lowest sequence number first.
 */
export function noteRefFragmentSearchStmt(
  read: ReadConn,
  projectId: string,
  fragment: string,
) {
  const pattern = `%${escapeLike(fragment)}%`;
  return read.execute(sql`
    SELECT n.id, n.slug, n.sequence_number, n.title, n.type, n.folder,
           n.summary, n.visibility, n.feed_mode, n.agent_writable, n.locked,
           n.updated_at, 1 AS rank
    FROM ${notes} n
    JOIN ${projects} p ON p.id = n.project_id
    WHERE n.project_id = ${projectId}
      AND n.deleted_at IS NULL
      AND (p.identifier || '-N' || n.sequence_number::text) ILIKE ${pattern} ESCAPE '\'
    ORDER BY n.sequence_number ASC
    LIMIT ${REF_FRAGMENT_LIMIT}
  `);
}
