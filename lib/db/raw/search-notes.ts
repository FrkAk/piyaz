/**
 * Full-text note search over the generated `search_tsv` column.
 *
 * Query text goes through `websearch_to_tsquery` (never raw `to_tsquery`,
 * which throws on arbitrary user input), falling back to
 * `plainto_tsquery` when websearch parsing yields an empty query.
 * Pure-negation queries (`querytree` = `'T'`, e.g. `-draft`) match
 * nothing instead of every note lacking the term. The
 * inner LATERAL subquery ranks and limits on the GIN index before the
 * outer `ts_headline` runs, so snippet generation touches at most
 * `NOTE_SEARCH_LIMIT` rows over a `left(body, ...)` slice — the raw body
 * and `search_tsv` are never selected.
 */

import { sql } from "drizzle-orm";
import { notes } from "@/lib/db/schema";
import { type ReadConn } from "@/lib/db/raw";

/** Maximum hits one search returns. */
const NOTE_SEARCH_LIMIT = 20;

/** Chars of `body` handed to `ts_headline` per hit; bounds detoast cost. */
const SNIPPET_SOURCE_CHARS = 4096;

/** Row shape returned by the note search query. */
export type NoteSearchRawRow = {
  id: string;
  slug: string;
  title: string;
  type: string;
  folder: string;
  summary: string;
  visibility: string;
  agent_writable: boolean;
  locked: boolean;
  updated_at: string | Date;
  rank: number;
  snippet: string;
};

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
  return read.execute(sql`
    WITH q AS (
      SELECT CASE
        WHEN numnode(websearch_to_tsquery('english', ${query})) = 0
          THEN plainto_tsquery('english', ${query})
        ELSE websearch_to_tsquery('english', ${query})
      END AS tsq
    )
    SELECT m.id, m.slug, m.title, m.type, m.folder, m.summary,
           m.visibility, m.agent_writable, m.locked, m.updated_at, m.rank,
           ts_headline('english', m.body_slice, q.tsq,
             'MaxFragments=2, MaxWords=18, MinWords=4, StartSel=**, StopSel=**'
           ) AS snippet
    FROM q, LATERAL (
      SELECT n.id, n.slug, n.title, n.type, n.folder, n.summary,
             n.visibility, n.agent_writable, n.locked, n.updated_at,
             ts_rank(n.search_tsv, q.tsq) AS rank,
             left(n.body, ${SNIPPET_SOURCE_CHARS}) AS body_slice
      FROM ${notes} n
      WHERE n.project_id = ${projectId}
        AND n.deleted_at IS NULL
        AND querytree(q.tsq) <> 'T'
        AND n.search_tsv @@ q.tsq
      ORDER BY rank DESC, n.updated_at DESC
      LIMIT ${NOTE_SEARCH_LIMIT}
    ) m
    ORDER BY m.rank DESC, m.updated_at DESC
  `);
}
