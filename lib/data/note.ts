/**
 * The single data-access module for Notes, mirroring `lib/data/task.ts`.
 *
 * Every read goes through `withUserContextRead` (one batch per entry
 * point) and every write through `withUserContext`; RLS is the tenant
 * boundary and `assertNoteAccess*` is the 404-shaped gate. Egress rules:
 * only {@link getNoteFull} selects `body`, nothing ever selects
 * `search_tsv`, and list/search projections stay slim.
 *
 * Activity events and the project-wide realtime dispatch fire only for
 * team-visible notes: the feed and the tree fan out to every member, so
 * a private note's title, slug, and folder must never land there.
 *
 * Agent-facing policy (`agent_writable`, the agent ban on setting
 * `visibility='team'`) is deliberately NOT enforced here — the MCP
 * handler layers it on (PYZ-252). `locked` is the exception: it gates
 * every writer in {@link updateNote} and the share transitions, so a
 * locked note is read-only for humans and agents alike until an unlock
 * patch (`locked: false`) lands. Human server actions call these
 * functions directly.
 */
import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  like,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { AuthContext } from "@/lib/auth/context";
import {
  assertNoteAccessTx,
  assertNoteGateRows,
  assertProjectAccessTx,
  assertProjectGateRows,
  assertTaskGateRows,
  assertValidNoteId,
  assertValidProjectId,
  assertValidTaskId,
  ForbiddenError,
  isUuid,
} from "@/lib/auth/authorization";
import {
  noteAccessGateStmt,
  projectAccessGateStmt,
  taskAccessGateStmt,
  type NoteAccessGate,
} from "@/lib/data/access";
import { insertActivityEvents } from "@/lib/data/activity";
import { escapeRegExp, extractNoteRefs } from "@/lib/data/note-parse";
import {
  NOTE_BODY_MAX_CHARS,
  NOTE_TITLE_MAX_BYTES,
  noteLinks,
  noteRevisions,
  notes,
  noteTaskLinks,
  projects,
  tasks,
  type Note,
} from "@/lib/db/schema";
import {
  executeRaw,
  normalizeExecuteResult,
  toDate,
  type ReadConn,
} from "@/lib/db/raw";
import { acquireProjectLock } from "@/lib/db/raw/acquire-project-lock";
import {
  notesTreeVersionStmt,
  type NotesTreeVersionRow,
} from "@/lib/db/raw/get-notes-max-updated-at";
import {
  notesFeedStmt,
  type FeedTask,
  type NoteFeedRawRow,
} from "@/lib/db/raw/notes-feed";
import {
  noteSearchStmt,
  type NoteSearchRawRow,
} from "@/lib/db/raw/search-notes";
import { withUserContext, withUserContextRead, type Tx } from "@/lib/db/rls";
import { ProjectArchivedError } from "@/lib/graph/errors";
import { asIdentifier, composeNoteRef } from "@/lib/graph/identifier";
import { emitNoteEvent, emitProjectEvent } from "@/lib/realtime/events";
import type {
  FeedMode,
  NoteTaskLinkKind,
  NoteType,
  TaskStatus,
  Visibility,
} from "@/lib/types";

/** Revisions kept per note; older rows are pruned in the write tx. */
const NOTE_REVISION_KEEP = 50;

/** Byte cap for generated slugs; leaves suffix headroom under the CHECK. */
const SLUG_MAX_BYTES = 240;

/** Char cap for the normalized `folder` path. */
const FOLDER_MAX_CHARS = 512;

/** Char cap for a search query string. */
const SEARCH_QUERY_MAX_CHARS = 256;

/** Char cap for `summary`; it is projected on every tree-list row. */
const SUMMARY_MAX_CHARS = 1000;

/** Char cap for `category` and each tag / feed label. */
const LABEL_MAX_CHARS = 200;

/** Item cap for `tags`, `feedCategories`, and `feedTags`. */
const LABEL_LIST_MAX_ITEMS = 500;

/** Item cap for `feedTaskIds`. */
const FEED_TASK_IDS_MAX_ITEMS = 1000;

/** Chars of a note title rendered into activity summaries. */
const SUMMARY_TITLE_MAX = 120;

/** Default note cap per feed resolution; Notes spec (PYZ-264 decisions) §7/§10 bundle bound. */
export const FEED_NOTE_CAP = 8;

/** Default char budget (title + summary lengths) per feed resolution. */
export const FEED_CHAR_BUDGET = 8000;

/** Cap on overflow pointers per feed resolution; also bounds the SQL fetch. */
export const FEED_POINTER_CAP = 32;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when `ifUpdatedAt` does not match the note's live `updatedAt`.
 * Carries the live values so callers can retry (`currentUpdatedAt`) and
 * the web conflict banner can render the live revision (`currentVersion`).
 */
export class NoteStaleWriteError extends Error {
  /**
   * @param currentUpdatedAt - The note's live `updatedAt`.
   * @param currentVersion - The note's live revision counter.
   */
  constructor(
    public readonly currentUpdatedAt: Date,
    public readonly currentVersion: number,
  ) {
    super(
      `Note changed since last read (updatedAt ${currentUpdatedAt.toISOString()})`,
    );
    this.name = "NoteStaleWriteError";
  }
}

/** Field a {@link NoteValidationError} refers to. */
export type NoteValidationField =
  | "title"
  | "body"
  | "folder"
  | "query"
  | "ifUpdatedAt"
  | "summary"
  | "category"
  | "tags"
  | "feedCategories"
  | "feedTags"
  | "feedTaskIds";

/**
 * Thrown when caller input fails a cheap pre-write check, so callers get
 * a typed error instead of a raw Postgres CHECK violation.
 */
export class NoteValidationError extends Error {
  /**
   * @param field - The offending input field.
   * @param message - Human-readable rejection reason.
   */
  constructor(
    public readonly field: NoteValidationField,
    message: string,
  ) {
    super(message);
    this.name = "NoteValidationError";
  }
}

/** Thrown by {@link moveFolder} when the move would create a cycle. */
export class FolderCycleError extends Error {
  /**
   * @param src - Folder being moved.
   * @param destParent - Requested destination parent.
   */
  constructor(
    public readonly src: string,
    public readonly destParent: string,
  ) {
    super(`Cannot move folder "${src}" into itself or a descendant`);
    this.name = "FolderCycleError";
  }
}

/** Reason a share-request state transition was rejected. */
export type NoteShareStateReason = "no_pending_request" | "already_team";

/**
 * Thrown when a share-request transition does not apply to the note's
 * current state (approving without a pending request, requesting on an
 * already-team note).
 */
export class NoteShareStateError extends Error {
  /**
   * @param reason - Which state precondition failed.
   */
  constructor(public readonly reason: NoteShareStateReason) {
    super(
      reason === "already_team"
        ? "Note is already visible to the team"
        : "Note has no pending share request",
    );
    this.name = "NoteShareStateError";
  }
}

/**
 * Thrown when a write targets a locked note. `locked` is a universal
 * write gate: every client (web actions and MCP alike) is read-only on a
 * locked note, and {@link updateNote} accepts a write only when it
 * unlocks the note (`locked: false`), which may bundle other field
 * changes in the same patch.
 */
export class NoteLockedError extends Error {
  constructor() {
    super("Note is locked. Unlock it to edit.");
    this.name = "NoteLockedError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Slim tree-list row; never carries `body` or `search_tsv`. */
export type NoteTreeRow = {
  id: string;
  slug: string;
  title: string;
  type: NoteType;
  folder: string;
  summary: string;
  visibility: Visibility;
  agentWritable: boolean;
  locked: boolean;
  updatedAt: Date;
};

/** A task this note references, with the columns the UI chip renders. */
export type NoteMention = {
  taskId: string;
  kind: NoteTaskLinkKind;
  taskRef: string;
  status: TaskStatus;
  title: string;
};

/** Slim linked-note row for the mentions / backlinks sections. */
export type LinkedNoteSlim = {
  id: string;
  slug: string;
  title: string;
  type: NoteType;
  folder: string;
  updatedAt: Date;
};

/** Slim backlink row for a task's linked notes; never carries `body`. */
export type TaskNoteBacklink = NoteTreeRow & {
  kind: NoteTaskLinkKind;
  sequenceNumber: number;
};

/** Full note row minus the server-side `search_tsv` column. */
export type NoteFull = Omit<Note, "searchTsv">;

/** Single-note read: the full row plus its derived link context. */
export type NoteFullResult = {
  note: NoteFull;
  mentions: NoteMention[];
  linksOut: LinkedNoteSlim[];
  linksIn: LinkedNoteSlim[];
};

/** One ranked search hit: the slim tree row, never the body. */
export type NoteSearchHit = NoteTreeRow;

export type { FeedTask };

/** Slim agent-exposed note row; never carries `body` or `search_tsv`. */
export type NoteFeedRow = {
  id: string;
  slug: string;
  title: string;
  type: NoteType;
  folder: string;
  summary: string;
  updatedAt: Date;
};

/** Pointer to an exposed note that overflowed the feed budget. */
export type NoteFeedPointer = {
  id: string;
  slug: string;
  title: string;
  type: NoteType;
};

/**
 * Budgeted feed resolution: admitted rows plus overflow pointers.
 * `truncated` is true when exposed notes beyond the fetch or pointer
 * bound were dropped, so the pointer list may be incomplete.
 */
export type NoteFeedResolution = {
  notes: NoteFeedRow[];
  overflow: NoteFeedPointer[];
  truncated: boolean;
};

/** Caps for {@link applyFeedBudget}; each clamps to [1, its default]. */
export type FeedBudget = {
  maxNotes?: number;
  maxChars?: number;
};

/** Cache validator for the tree list (see PYZ-254 ETag contract). */
export type NotesTreeVersion = {
  maxUpdatedAt: Date | null;
  liveCount: number;
};

/** Slim write-result shape returned by every note mutation. */
export type NoteSummary = {
  id: string;
  slug: string;
  title: string;
  projectId: string;
  folder: string;
  version: number;
  updatedAt: Date;
};

/**
 * Link context re-derived by a body-changing {@link updateNote}, read back
 * inside the write transaction so the client folds it into its detail
 * cache instead of refetching. `linksIn` is excluded: incoming rows belong
 * to other notes' derivations and never change from this note's write.
 */
export type NoteLinksRefresh = {
  mentions: NoteMention[];
  linksOut: LinkedNoteSlim[];
};

/** Impact preview for {@link deleteNote}. */
export type DeleteNotePreview = {
  note: { id: string; title: string; slug: string };
  taskLinks: number;
  incomingLinks: number;
  outgoingLinks: number;
  revisions: number;
};

/** Caller-supplied fields for {@link createNote}. */
export type CreateNoteInput = {
  projectId: string;
  title: string;
  body?: string;
  folder?: string;
  type?: NoteType;
  visibility?: Visibility;
  summary?: string;
  tags?: string[];
  category?: string | null;
};

/** Mutable scalar fields accepted by {@link updateNote}. */
export type NotePatch = {
  title?: string;
  folder?: string;
  tags?: string[];
  type?: NoteType;
  category?: string | null;
  summary?: string;
  body?: string;
  feedMode?: FeedMode;
  feedCategories?: string[];
  feedTags?: string[];
  feedTaskIds?: string[];
  agentWritable?: boolean;
  locked?: boolean;
  visibility?: Visibility;
};

/** The patch keys {@link updateNote} applies; everything else is stripped. */
const PATCHABLE_NOTE_FIELDS = [
  "title",
  "folder",
  "tags",
  "type",
  "category",
  "summary",
  "body",
  "feedMode",
  "feedCategories",
  "feedTags",
  "feedTaskIds",
  "agentWritable",
  "locked",
  "visibility",
] as const satisfies readonly (keyof NotePatch)[];

/** Summary projection shared by every write's `.returning()`. */
const noteSummaryColumns = {
  id: notes.id,
  slug: notes.slug,
  title: notes.title,
  projectId: notes.projectId,
  folder: notes.folder,
  version: notes.version,
  updatedAt: notes.updatedAt,
} as const;

/** Slim tree-list projection; excludes `body` and `search_tsv` by design. */
const noteTreeColumns = {
  id: notes.id,
  slug: notes.slug,
  title: notes.title,
  type: notes.type,
  folder: notes.folder,
  summary: notes.summary,
  visibility: notes.visibility,
  agentWritable: notes.agentWritable,
  locked: notes.locked,
  updatedAt: notes.updatedAt,
} as const;

/**
 * Full-row projection for the single-note read: every column except the
 * server-side `search_tsv` (large, index-only — a bare `select()` would
 * ship it on every row).
 */
const noteFullColumns = {
  id: notes.id,
  projectId: notes.projectId,
  sequenceNumber: notes.sequenceNumber,
  type: notes.type,
  folder: notes.folder,
  title: notes.title,
  slug: notes.slug,
  summary: notes.summary,
  body: notes.body,
  visibility: notes.visibility,
  agentWritable: notes.agentWritable,
  locked: notes.locked,
  feedMode: notes.feedMode,
  feedCategories: notes.feedCategories,
  feedTags: notes.feedTags,
  feedTaskIds: notes.feedTaskIds,
  tags: notes.tags,
  category: notes.category,
  version: notes.version,
  embeddingStatus: notes.embeddingStatus,
  shareRequestedBy: notes.shareRequestedBy,
  createdBy: notes.createdBy,
  updatedBy: notes.updatedBy,
  createdAt: notes.createdAt,
  updatedAt: notes.updatedAt,
  deletedAt: notes.deletedAt,
} as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Byte length of a string in UTF-8, matching Postgres `octet_length`.
 *
 * @param value - Input string.
 * @returns Encoded byte count.
 */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Canonicalize feed match values to trimmed lowercase with empties
 * dropped and duplicates collapsed, the single form the §7 exposure
 * arms compare on both sides. Applied to labels and feed task ids
 * alike (trim is a no-op on well-formed UUIDs).
 *
 * @param values - Raw value list.
 * @returns Deduplicated, trimmed, lowercased values.
 */
function canonicalizeFeedLabels(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ];
}

/**
 * Truncate a string to a UTF-8 byte budget without splitting a codepoint.
 *
 * @param value - Input string.
 * @param maxBytes - Byte budget.
 * @returns The longest prefix that fits.
 */
function truncateToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const codepoint of value) {
    const size = byteLength(codepoint);
    if (bytes + size > maxBytes) break;
    result += codepoint;
    bytes += size;
  }
  return result;
}

/**
 * Derive the kebab-case slug base from a note title. Unicode letters and
 * digits survive so non-Latin titles keep meaningful slugs.
 *
 * @param title - Raw note title.
 * @returns Slug base within {@link SLUG_MAX_BYTES}, `untitled` fallback.
 */
function slugifyTitle(title: string): string {
  const kebab = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{Ll}\p{Lo}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const capped = truncateToBytes(kebab, SLUG_MAX_BYTES).replace(/-+$/g, "");
  return capped === "" ? "untitled" : capped;
}

/**
 * Escape LIKE pattern metacharacters so user-derived prefixes match
 * literally.
 *
 * @param value - Literal string destined for a LIKE pattern.
 * @returns The string with `\`, `%`, and `_` escaped.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Pick the next free slug in a base's namespace: the base itself when
 * free, else `base-<n+1>` past the highest taken suffix (first duplicate
 * gets `-2`).
 *
 * @param base - Slug base from {@link slugifyTitle}.
 * @param taken - Live slugs already occupying the namespace.
 * @returns A slug not present in `taken`.
 */
function nextFreeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  const suffixRe = new RegExp(`^${escapeRegExp(base)}-(\\d+)$`);
  let highest = 1;
  for (const slug of taken) {
    const match = suffixRe.exec(slug);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > highest) highest = n;
  }
  return `${base}-${highest + 1}`;
}

/**
 * Normalize a folder path: split on `/`, trim segments, drop empties.
 *
 * @param raw - Caller-supplied folder path.
 * @returns Canonical path (`""` = root).
 * @throws NoteValidationError when the normalized path exceeds the cap.
 */
function normalizeFolder(raw: string): string {
  const folder = raw
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .join("/");
  if (folder.length > FOLDER_MAX_CHARS) {
    throw new NoteValidationError(
      "folder",
      `folder exceeds ${FOLDER_MAX_CHARS} characters`,
    );
  }
  return folder;
}

/**
 * Validate a note title against the DB byte cap.
 *
 * @param title - Candidate title.
 * @throws NoteValidationError when the title exceeds the cap.
 */
function assertTitleWithinCap(title: string): void {
  if (byteLength(title) > NOTE_TITLE_MAX_BYTES) {
    throw new NoteValidationError(
      "title",
      `title exceeds ${NOTE_TITLE_MAX_BYTES} bytes`,
    );
  }
}

/**
 * Validate a note body against the DB char cap.
 *
 * @param body - Candidate body.
 * @throws NoteValidationError when the body exceeds the cap.
 */
function assertBodyWithinCap(body: string): void {
  if (body.length > NOTE_BODY_MAX_CHARS) {
    throw new NoteValidationError(
      "body",
      `body exceeds ${NOTE_BODY_MAX_CHARS} characters`,
    );
  }
}

/** The slim metadata fields {@link assertMetadataWithinCaps} validates. */
type NoteMetadataFields = Pick<
  NotePatch,
  | "summary"
  | "category"
  | "tags"
  | "feedCategories"
  | "feedTags"
  | "feedTaskIds"
>;

/**
 * Validate the slim metadata fields against their caps. `summary` rides
 * every tree-list row and search hit, and the label arrays are indexed,
 * so unbounded values inflate every downstream read.
 *
 * @param fields - Candidate metadata fields; absent fields are skipped.
 * @throws NoteValidationError on any cap violation or non-UUID feed task id.
 */
function assertMetadataWithinCaps(fields: NoteMetadataFields): void {
  if (
    fields.summary !== undefined &&
    fields.summary.length > SUMMARY_MAX_CHARS
  ) {
    throw new NoteValidationError(
      "summary",
      `summary exceeds ${SUMMARY_MAX_CHARS} characters`,
    );
  }
  if (fields.category != null && fields.category.length > LABEL_MAX_CHARS) {
    throw new NoteValidationError(
      "category",
      `category exceeds ${LABEL_MAX_CHARS} characters`,
    );
  }
  for (const field of ["tags", "feedCategories", "feedTags"] as const) {
    const values = fields[field];
    if (values === undefined) continue;
    if (values.length > LABEL_LIST_MAX_ITEMS) {
      throw new NoteValidationError(
        field,
        `${field} exceeds ${LABEL_LIST_MAX_ITEMS} items`,
      );
    }
    if (values.some((value) => value.length > LABEL_MAX_CHARS)) {
      throw new NoteValidationError(
        field,
        `${field} items exceed ${LABEL_MAX_CHARS} characters`,
      );
    }
  }
  if (fields.feedTaskIds !== undefined) {
    if (fields.feedTaskIds.length > FEED_TASK_IDS_MAX_ITEMS) {
      throw new NoteValidationError(
        "feedTaskIds",
        `feedTaskIds exceeds ${FEED_TASK_IDS_MAX_ITEMS} items`,
      );
    }
    if (fields.feedTaskIds.some((id) => !isUuid(id))) {
      throw new NoteValidationError(
        "feedTaskIds",
        "feedTaskIds items must be UUIDs",
      );
    }
  }
}

/**
 * Parse an `ifUpdatedAt` precondition into epoch milliseconds.
 *
 * @param ifUpdatedAt - ISO timestamp from a prior read.
 * @returns Epoch milliseconds.
 * @throws NoteValidationError when the value is not a parseable instant.
 */
function parseIfUpdatedAt(ifUpdatedAt: string): number {
  const ms = new Date(ifUpdatedAt).getTime();
  if (Number.isNaN(ms)) {
    throw new NoteValidationError(
      "ifUpdatedAt",
      "ifUpdatedAt is not a valid timestamp",
    );
  }
  return ms;
}

/**
 * Reject writes into archived projects, mirroring task-write behavior.
 *
 * @param projectStatus - Parent project lifecycle status.
 * @param projectIdentifier - Identifier for the reopen hint.
 * @throws ProjectArchivedError when the project is archived.
 */
function assertProjectWritable(
  projectStatus: string,
  projectIdentifier: string,
): void {
  if (projectStatus === "archived") {
    throw new ProjectArchivedError(projectIdentifier);
  }
}

/**
 * Reject writes against a trashed note; restore is the only mutation
 * allowed to touch one, and reads never surface them.
 *
 * @param gate - Note access-gate row.
 * @throws ForbiddenError when the note is soft-deleted (404-shaped).
 */
function assertNoteLive(gate: NoteAccessGate): void {
  if (gate.deletedAt !== null) {
    throw new ForbiddenError("Forbidden", "note", gate.id);
  }
}

/**
 * Clamp a note title for activity-event summaries.
 *
 * @param title - Note title.
 * @returns Title capped at {@link SUMMARY_TITLE_MAX} chars.
 */
function summaryTitle(title: string): string {
  return title.length <= SUMMARY_TITLE_MAX
    ? title
    : `${title.slice(0, SUMMARY_TITLE_MAX - 1)}…`;
}

/**
 * Compose a {@link NoteSummary} from any row carrying the summary
 * columns (access-gate rows, locked baseline reads), so no-op paths
 * return it without a redundant select.
 *
 * @param gate - Row carrying the summary columns.
 * @returns Slim summary of the note.
 */
function gateSummary(
  gate: Pick<
    NoteAccessGate,
    "id" | "slug" | "title" | "projectId" | "folder" | "version" | "updatedAt"
  >,
): NoteSummary {
  return {
    id: gate.id,
    slug: gate.slug,
    title: gate.title,
    projectId: gate.projectId,
    folder: gate.folder,
    version: gate.version,
    updatedAt: gate.updatedAt,
  };
}

/** Patch fields compared by JSON value rather than identity. */
const JSON_PATCH_FIELDS = new Set<keyof NotePatch>([
  "tags",
  "feedCategories",
  "feedTags",
  "feedTaskIds",
]);

/**
 * Remove patch fields whose value equals the note's current value, so a
 * value-equal patch takes the no-op path (no UPDATE, no activity event,
 * no emit) and `updatedAt` stays a faithful change marker. Mutates
 * `applied` in place.
 *
 * @param applied - Sanitized patch (mutated in place).
 * @param current - Current column values from the locked re-read.
 * @param bodyChanged - Whether the patch body differs from the current body.
 * @returns The effectively changed field names.
 */
function dropUnchangedFields(
  applied: NotePatch,
  current: Pick<Note, Exclude<keyof NotePatch, "body">>,
  bodyChanged: boolean,
): string[] {
  for (const field of Object.keys(applied) as (keyof NotePatch)[]) {
    if (field === "body") {
      if (!bodyChanged) delete applied.body;
      continue;
    }
    const unchanged = JSON_PATCH_FIELDS.has(field)
      ? JSON.stringify(applied[field]) === JSON.stringify(current[field])
      : applied[field] === current[field];
    if (unchanged) delete applied[field];
  }
  return Object.keys(applied);
}

// ---------------------------------------------------------------------------
// In-transaction helpers
// ---------------------------------------------------------------------------

/**
 * Query the live slugs occupying a base's namespace. Goes through the
 * `note_slugs_in_namespace` SECURITY DEFINER read: the namespace spans
 * every visibility (the partial unique index does too), so an RLS-scoped
 * read blind to other members' private notes would allocate a colliding
 * slug and abort with a raw 23505. Must run while the caller holds
 * `acquireProjectLock` — the advisory lock is what makes the subsequent
 * check-then-write race-free.
 *
 * @param tx - Active RLS transaction handle.
 * @param projectId - Owning project id.
 * @param base - Slug base whose namespace to load.
 * @param extraSlug - Additional slug to include in the availability check
 *   even when it falls outside the base's namespace (restore after a
 *   title rename).
 * @returns The set of live slugs matching `base`, `base-%`, or `extraSlug`.
 */
async function loadSlugNamespace(
  tx: Tx,
  projectId: string,
  base: string,
  extraSlug?: string,
): Promise<Set<string>> {
  const rows = await executeRaw<{ slug: string }>(
    tx,
    sql`SELECT slug FROM public.note_slugs_in_namespace(${projectId}, ${base}, ${`${escapeLike(base)}-%`}, ${extraSlug ?? null})`,
  );
  return new Set(rows.map((row) => row.slug));
}

/**
 * Re-derive a note's body-driven links inside the body-write transaction.
 * Deletes then reinserts ONLY the derivation-owned rows: `note_task_links`
 * with `kind='mention'` (user-managed `reference`/`spec_of` rows survive)
 * and the note's outgoing `note_links` (incoming rows belong to other
 * notes' derivations). Unresolved refs are not stored; RLS hides other
 * members' private notes from the title lookup, so derivation can never
 * link to a note the author cannot see.
 *
 * @param tx - Active RLS transaction handle.
 * @param noteId - Source note id.
 * @param projectId - Owning project id.
 * @param projectIdentifier - Identifier task refs are parsed against.
 * @param body - The new note body.
 * @param isNew - Skip the scoped deletes for a freshly inserted note.
 */
async function replaceDerivedLinks(
  tx: Tx,
  noteId: string,
  projectId: string,
  projectIdentifier: string,
  body: string,
  isNew: boolean,
): Promise<void> {
  const { taskSeqs, titles } = extractNoteRefs(body, projectIdentifier);

  let taskIds: string[] = [];
  if (taskSeqs.length > 0) {
    const rows = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, projectId),
          inArray(tasks.sequenceNumber, taskSeqs),
        ),
      );
    taskIds = rows.map((row) => row.id);
  }

  let targetNoteIds: string[] = [];
  if (titles.length > 0) {
    const lowered = titles.map((title) => title.toLowerCase());
    const rows = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(
          eq(notes.projectId, projectId),
          isNull(notes.deletedAt),
          ne(notes.id, noteId),
          sql`LOWER(${notes.title}) IN (${sql.join(
            lowered.map((title) => sql`${title}`),
            sql`, `,
          )})`,
        ),
      );
    targetNoteIds = rows.map((row) => row.id);
  }

  if (!isNew) {
    await tx
      .delete(noteTaskLinks)
      .where(
        and(
          eq(noteTaskLinks.noteId, noteId),
          eq(noteTaskLinks.kind, "mention"),
        ),
      );
    await tx.delete(noteLinks).where(eq(noteLinks.sourceNoteId, noteId));
  }
  if (taskIds.length > 0) {
    await tx.insert(noteTaskLinks).values(
      taskIds.map((taskId) => ({
        noteId,
        taskId,
        kind: "mention" as const,
      })),
    );
  }
  if (targetNoteIds.length > 0) {
    await tx.insert(noteLinks).values(
      targetNoteIds.map((targetNoteId) => ({
        sourceNoteId: noteId,
        targetNoteId,
      })),
    );
  }
}

/**
 * Snapshot a note body into `note_revisions` and prune past the retention
 * cap. Runs in the body-write transaction; `created_by` is pinned to the
 * caller by the table's RLS WITH CHECK, and DELETE (not UPDATE) is the
 * grant the prune relies on.
 *
 * @param tx - Active RLS transaction handle.
 * @param noteId - Note id.
 * @param version - Revision counter value being snapshotted.
 * @param title - Note title at this revision.
 * @param body - Note body at this revision.
 * @param userId - Acting user attributed as `created_by`.
 */
async function insertRevisionWithPrune(
  tx: Tx,
  noteId: string,
  version: number,
  title: string,
  body: string,
  userId: string,
): Promise<void> {
  await tx.insert(noteRevisions).values({
    noteId,
    version,
    title,
    body,
    createdBy: userId,
  });
  await tx
    .delete(noteRevisions)
    .where(
      and(
        eq(noteRevisions.noteId, noteId),
        sql`${noteRevisions.version} <= ${version - NOTE_REVISION_KEEP}`,
      ),
    );
}

// ---------------------------------------------------------------------------
// Lazy statement builders (composable into downstream read batches)
// ---------------------------------------------------------------------------

/**
 * Build the slim tree-list read as a lazy batch statement. Live notes
 * only, ordered by folder then title; never selects `body`/`search_tsv`.
 * Batch alongside `projectAccessGateStmt` and evaluate the gate rows
 * first — RLS protects the rows, but only the gate 404-shapes a missing
 * or cross-team project.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project.
 * @returns Lazy select statement yielding {@link NoteTreeRow}s.
 */
export function noteTreeListStmt(read: ReadConn, projectId: string) {
  return read
    .select(noteTreeColumns)
    .from(notes)
    .where(and(eq(notes.projectId, projectId), isNull(notes.deletedAt)))
    .orderBy(notes.folder, notes.title);
}

/**
 * Build the single live-note full-row read as a lazy batch statement.
 * Every column except `search_tsv`; trashed notes yield zero rows.
 * Batch alongside `noteAccessGateStmt` and evaluate the gate rows first
 * (`assertNoteGateRows`) so missing and cross-team notes 404-shape.
 *
 * @param read - Read statement-building handle.
 * @param noteId - UUID of the note.
 * @returns Lazy select statement yielding zero or one {@link NoteFull}s.
 */
export function noteRowStmt(read: ReadConn, noteId: string) {
  return read
    .select(noteFullColumns)
    .from(notes)
    .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
    .limit(1);
}

/**
 * Build the mentions read as a lazy batch statement: the tasks this note
 * links to, with the identifier + sequence columns taskRef composition
 * needs. Batch alongside `noteAccessGateStmt` and evaluate the gate rows
 * first.
 *
 * @param read - Read statement-building handle.
 * @param noteId - UUID of the note.
 * @returns Lazy select statement yielding mention rows.
 */
export function noteMentionsStmt(read: ReadConn, noteId: string) {
  return read
    .select({
      taskId: noteTaskLinks.taskId,
      kind: noteTaskLinks.kind,
      sequenceNumber: tasks.sequenceNumber,
      identifier: projects.identifier,
      status: tasks.status,
      title: tasks.title,
    })
    .from(noteTaskLinks)
    .innerJoin(tasks, eq(tasks.id, noteTaskLinks.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(noteTaskLinks.noteId, noteId));
}

/**
 * Map a raw mention row (task join with identifier and sequence) to the
 * {@link NoteMention} shape with the composed task ref.
 *
 * @param row - Joined mention row.
 * @returns Mention row for the UI chip.
 */
function toNoteMention(row: {
  taskId: string;
  kind: NoteTaskLinkKind;
  sequenceNumber: number;
  identifier: string;
  status: TaskStatus;
  title: string;
}): NoteMention {
  return {
    taskId: row.taskId,
    kind: row.kind,
    taskRef: `${row.identifier}-${row.sequenceNumber}`,
    status: row.status,
    title: row.title,
  };
}

/**
 * Build the task-backlinks read as a lazy batch statement: live notes
 * linked to the task via `note_task_links`, slim tree projection plus the
 * link `kind` and the note `sequenceNumber` (for the ref chip); never
 * selects `body`/`search_tsv`. Served by
 * `note_task_links_task_id_idx`. Batch alongside `taskAccessGateStmt`
 * and evaluate the gate rows first.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the task.
 * @returns Lazy select statement yielding {@link TaskNoteBacklink}s.
 */
export function taskNoteBacklinksStmt(read: ReadConn, taskId: string) {
  return read
    .select({
      ...noteTreeColumns,
      kind: noteTaskLinks.kind,
      sequenceNumber: notes.sequenceNumber,
    })
    .from(noteTaskLinks)
    .innerJoin(notes, eq(notes.id, noteTaskLinks.noteId))
    .where(and(eq(noteTaskLinks.taskId, taskId), isNull(notes.deletedAt)))
    .orderBy(notes.title, noteTaskLinks.kind);
}

/**
 * Shared core of the linked-note reads: live notes on the far end of a
 * `note_links` row, slim projection.
 *
 * @param read - Read statement-building handle.
 * @param noteId - UUID of the near-end note.
 * @param direction - `out` joins targets and filters by source;
 *   `in` joins sources and filters by target (backlinks).
 * @returns Lazy select statement yielding {@link LinkedNoteSlim}s.
 */
function linkedNotesStmt(
  read: ReadConn,
  noteId: string,
  direction: "out" | "in",
) {
  const farColumn =
    direction === "out" ? noteLinks.targetNoteId : noteLinks.sourceNoteId;
  const nearColumn =
    direction === "out" ? noteLinks.sourceNoteId : noteLinks.targetNoteId;
  return read
    .select({
      id: notes.id,
      slug: notes.slug,
      title: notes.title,
      type: notes.type,
      folder: notes.folder,
      updatedAt: notes.updatedAt,
    })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, farColumn))
    .where(and(eq(nearColumn, noteId), isNull(notes.deletedAt)));
}

/**
 * Build the outgoing note-links read as a lazy batch statement: live
 * notes this note links to, slim projection. Batch alongside
 * `noteAccessGateStmt` and evaluate the gate rows first.
 *
 * @param read - Read statement-building handle.
 * @param noteId - UUID of the source note.
 * @returns Lazy select statement yielding {@link LinkedNoteSlim}s.
 */
export function noteLinksOutStmt(read: ReadConn, noteId: string) {
  return linkedNotesStmt(read, noteId, "out");
}

/**
 * Build the incoming note-links read as a lazy batch statement: live
 * notes linking to this note (backlinks), slim projection. Batch
 * alongside `noteAccessGateStmt` and evaluate the gate rows first.
 *
 * @param read - Read statement-building handle.
 * @param noteId - UUID of the target note.
 * @returns Lazy select statement yielding {@link LinkedNoteSlim}s.
 */
export function noteLinksInStmt(read: ReadConn, noteId: string) {
  return linkedNotesStmt(read, noteId, "in");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List a project's live notes as the slim tree projection. One read
 * batch: project gate + tree list.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Tree rows ordered by folder, then title.
 * @throws ForbiddenError when the caller cannot access the project.
 */
export async function getNoteTreeList(
  ctx: AuthContext,
  projectId: string,
): Promise<NoteTreeRow[]> {
  assertValidProjectId(projectId);
  const [gateRows, treeRows] = await withUserContextRead(ctx.userId, (read) => [
    projectAccessGateStmt(read, projectId),
    noteTreeListStmt(read, projectId),
  ]);
  assertProjectGateRows(projectId, gateRows);
  return treeRows;
}

/**
 * Read the tree-list cache validator: latest live `updated_at` plus the
 * live-row count (the count catches soft deletes MAX alone misses).
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns The validator pair; `maxUpdatedAt` is null with zero notes.
 * @throws ForbiddenError when the caller cannot access the project.
 */
export async function getNotesTreeVersion(
  ctx: AuthContext,
  projectId: string,
): Promise<NotesTreeVersion> {
  assertValidProjectId(projectId);
  const [gateRows, versionRaw] = await withUserContextRead(
    ctx.userId,
    (read) => [
      projectAccessGateStmt(read, projectId),
      notesTreeVersionStmt(read, projectId),
    ],
  );
  assertProjectGateRows(projectId, gateRows);
  const [row] = normalizeExecuteResult<NotesTreeVersionRow>(versionRaw);
  const max = row?.max_updated_at ?? null;
  return {
    maxUpdatedAt: max === null ? null : toDate(max),
    liveCount: Number(row?.live_count ?? 0),
  };
}

/**
 * Read one live note in full: the row (minus `search_tsv`), its task
 * mentions, and linked notes in both directions. ONE read batch of five
 * statements; the only read path that selects `body`.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @returns The note with derived link context.
 * @throws ForbiddenError on malformed id, missing, trashed, cross-team,
 *   or another member's private note.
 */
export async function getNoteFull(
  ctx: AuthContext,
  noteId: string,
): Promise<NoteFullResult> {
  assertValidNoteId(noteId);
  const [gateRows, noteRows, mentionRows, linksOut, linksIn] =
    await withUserContextRead(ctx.userId, (read) => [
      noteAccessGateStmt(read, noteId),
      noteRowStmt(read, noteId),
      noteMentionsStmt(read, noteId),
      noteLinksOutStmt(read, noteId),
      noteLinksInStmt(read, noteId),
    ]);
  assertNoteGateRows(noteId, gateRows);
  const [note] = noteRows;
  if (!note) throw new ForbiddenError("Forbidden", "note", noteId);
  return {
    note,
    mentions: mentionRows.map(toNoteMention),
    linksOut,
    linksIn,
  };
}

/**
 * Rank-search a project's live notes over the generated `search_tsv`.
 * User text goes through `websearch_to_tsquery` (plainto fallback), never
 * raw `to_tsquery`; the last term also matches as a sanitized prefix
 * lexeme for type-ahead. Hits are the slim tree projection, never the
 * body.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project to search in.
 * @param query - User search text.
 * @returns Up to 20 hits, best rank first; empty for a blank query.
 * @throws ForbiddenError when the caller cannot access the project.
 * @throws NoteValidationError when the query exceeds the length cap.
 */
export async function searchNotes(
  ctx: AuthContext,
  projectId: string,
  query: string,
): Promise<NoteSearchHit[]> {
  assertValidProjectId(projectId);
  const trimmed = query.trim();
  if (trimmed.length > SEARCH_QUERY_MAX_CHARS) {
    throw new NoteValidationError(
      "query",
      `query exceeds ${SEARCH_QUERY_MAX_CHARS} characters`,
    );
  }
  if (trimmed === "") {
    const [gateRows] = await withUserContextRead(ctx.userId, (read) => [
      projectAccessGateStmt(read, projectId),
    ]);
    assertProjectGateRows(projectId, gateRows);
    return [];
  }
  const [gateRows, hitsRaw] = await withUserContextRead(ctx.userId, (read) => [
    projectAccessGateStmt(read, projectId),
    noteSearchStmt(read, projectId, trimmed),
  ]);
  assertProjectGateRows(projectId, gateRows);
  return normalizeExecuteResult<NoteSearchRawRow>(hitsRaw).map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    type: row.type as NoteType,
    folder: row.folder,
    summary: row.summary,
    visibility: row.visibility as Visibility,
    agentWritable: row.agent_writable,
    locked: row.locked,
    updatedAt: toDate(row.updated_at),
  }));
}

/** A cross-project note search result for the global ⌘K palette. */
export type CrossProjectNoteSearchResult = {
  /** Note UUID — drives the deep link. */
  id: string;
  /** Composed note ref, e.g. `RSC-N4`. */
  noteRef: string;
  /** Note title. */
  title: string;
  /** Owning project UUID — drives the deep link. */
  projectId: string;
  /** Owning project identifier (prefix shown in the note ref). */
  projectIdentifier: string;
  /** Owning project title — the palette project crumb. */
  projectTitle: string;
  /** Owning team UUID. */
  organizationId: string;
};

/**
 * Cross-project note search for the ⌘K palette. Bounded by
 * `current_user_orgs()` (defense-in-depth over RLS); note visibility
 * (private rows confined to their creator, team rows org-wide) is enforced
 * by the `notes` RLS policy under `withUserContext`, so private notes never
 * leak cross-tenant.
 *
 * Per-token OR match: `notes.title`, `projects.title`, `projects.identifier`
 * (case-insensitive substring). Tokens AND-join. Ranked exact → prefix →
 * substring on title, then `updated_at` desc. Live notes only; `body` is
 * never selected.
 *
 * @param ctx - Resolved auth context.
 * @param query - Search string.
 * @param opts - Optional limit (1-25, default 10).
 * @returns Up to `opts.limit` matching notes with project crumb metadata.
 * @throws NoteValidationError When the query exceeds the length cap.
 */
export async function searchNotesAcrossProjects(
  ctx: AuthContext,
  query: string,
  opts: { limit?: number } = {},
): Promise<CrossProjectNoteSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length > SEARCH_QUERY_MAX_CHARS) {
    throw new NoteValidationError(
      "query",
      `query exceeds ${SEARCH_QUERY_MAX_CHARS} characters`,
    );
  }

  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const lower = trimmed.toLowerCase();
  const rankExpr = sql<number>`CASE
      WHEN LOWER(${notes.title}) = ${lower} THEN 0
      WHEN LOWER(${notes.title}) LIKE ${lower + "%"} THEN 1
      WHEN LOWER(${notes.title}) LIKE ${"%" + lower + "%"} THEN 2
      ELSE 3
    END`;

  return withUserContext(ctx.userId, async (tx) => {
    const orgRows = await executeRaw<{ org_id: string }>(
      tx,
      sql`SELECT org_id FROM public.current_user_orgs()`,
    );
    const orgIds = orgRows.map((r) => r.org_id);
    if (orgIds.length === 0) return [];

    const tokens = trimmed.split(/[\s-]+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return [];

    const clauses = [
      inArray(projects.organizationId, orgIds),
      isNull(notes.deletedAt),
    ];
    for (const token of tokens) {
      const pattern = `%${token}%`;
      const tokenClause = or(
        ilike(notes.title, pattern),
        ilike(projects.title, pattern),
        ilike(projects.identifier, pattern),
      );
      if (tokenClause) clauses.push(tokenClause);
    }

    const rows = await tx
      .select({
        id: notes.id,
        title: notes.title,
        sequenceNumber: notes.sequenceNumber,
        projectId: notes.projectId,
        projectIdentifier: projects.identifier,
        projectTitle: projects.title,
        organizationId: projects.organizationId,
      })
      .from(notes)
      .innerJoin(projects, eq(projects.id, notes.projectId))
      .where(and(...clauses))
      .orderBy(rankExpr, desc(notes.updatedAt), asc(notes.id))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      noteRef: composeNoteRef(
        asIdentifier(row.projectIdentifier),
        row.sequenceNumber,
      ),
      title: row.title,
      projectId: row.projectId,
      projectIdentifier: row.projectIdentifier,
      projectTitle: row.projectTitle,
      organizationId: row.organizationId,
    }));
  });
}

/** Specificity rank per backlink kind; higher wins the per-note dedupe. */
const BACKLINK_KIND_RANK: Record<NoteTaskLinkKind, number> = {
  spec_of: 2,
  reference: 1,
  mention: 0,
};

/**
 * List the live notes linked to a task via `note_task_links` as the slim
 * tree projection plus the link `kind`. One read batch: task gate +
 * backlinks. A note linked under several kinds (unique on note, task,
 * kind) collapses to one row carrying the most specific kind
 * (`spec_of` > `reference` > `mention`).
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Backlink rows ordered by note title.
 * @throws ForbiddenError on malformed id, missing task, or cross-team access.
 */
export async function getTaskNoteBacklinks(
  ctx: AuthContext,
  taskId: string,
): Promise<TaskNoteBacklink[]> {
  assertValidTaskId(taskId);
  const [gateRows, linkRows] = await withUserContextRead(ctx.userId, (read) => [
    taskAccessGateStmt(read, taskId),
    taskNoteBacklinksStmt(read, taskId),
  ]);
  assertTaskGateRows(taskId, gateRows);
  const byNote = new Map<string, TaskNoteBacklink>();
  for (const row of linkRows) {
    const existing = byNote.get(row.id);
    if (
      !existing ||
      BACKLINK_KIND_RANK[row.kind] > BACKLINK_KIND_RANK[existing.kind]
    ) {
      byNote.set(row.id, row);
    }
  }
  return [...byNote.values()];
}

/**
 * Resolve a caller budget to effective caps: each value clamps to
 * [1, its default], so budgets can only tighten the defaults.
 *
 * @param budget - Optional caller caps.
 * @returns Effective note and char caps.
 */
function clampFeedBudget(budget?: FeedBudget): {
  maxNotes: number;
  maxChars: number;
} {
  return {
    maxNotes: Math.min(
      Math.max(budget?.maxNotes ?? FEED_NOTE_CAP, 1),
      FEED_NOTE_CAP,
    ),
    maxChars: Math.min(
      Math.max(budget?.maxChars ?? FEED_CHAR_BUDGET, 1),
      FEED_CHAR_BUDGET,
    ),
  };
}

/**
 * Apply the §7/§10 bundle budget to exposure-ordered feed rows: admit a
 * strict prefix while both the note cap and the running char budget
 * (per-row `title.length + summary.length`) hold; the first row failing
 * either bound stops admission and remaining rows degrade to pointers,
 * capped at {@link FEED_POINTER_CAP} with `truncated` flagging any drop.
 * Pure; PYZ-253 consumes the feed through {@link resolveExposedNotes},
 * never the raw statement.
 *
 * @param rows - Exposed rows, already ordered `updatedAt DESC, id ASC`.
 * @param budget - Optional caps; each clamps to [1, its default]
 *   ({@link FEED_NOTE_CAP} / {@link FEED_CHAR_BUDGET}).
 * @returns Admitted rows, pointer-only overflow, and a truncation flag.
 */
export function applyFeedBudget(
  rows: NoteFeedRow[],
  budget?: FeedBudget,
): NoteFeedResolution {
  const { maxNotes, maxChars } = clampFeedBudget(budget);
  const admitted: NoteFeedRow[] = [];
  let runningChars = 0;
  let cut = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const rowChars = rows[i].title.length + rows[i].summary.length;
    if (admitted.length >= maxNotes || runningChars + rowChars > maxChars) {
      cut = i;
      break;
    }
    admitted.push(rows[i]);
    runningChars += rowChars;
  }
  const pointerEnd = Math.min(cut + FEED_POINTER_CAP, rows.length);
  const overflow = rows.slice(cut, pointerEnd).map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    type: row.type,
  }));
  return { notes: admitted, overflow, truncated: pointerEnd < rows.length };
}

/**
 * Coerce a raw feed row to its typed shape (`updated_at` arrives as a
 * string or a Date depending on the driver).
 *
 * @param row - Raw driver row.
 * @returns Typed feed row.
 */
function mapNoteFeedRow(row: NoteFeedRawRow): NoteFeedRow {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    type: row.type as NoteType,
    folder: row.folder,
    summary: row.summary,
    updatedAt: toDate(row.updated_at),
  };
}

/**
 * Resolve the notes an agent may see for one task: the single §7
 * exposure authority for the planned note-search (PYZ-251) and
 * context-injection (PYZ-253) call sites. A note is exposed iff
 * `visibility = 'team'` AND `feed_mode <> 'none'` AND its feed mode
 * targets the task; the budget then degrades overflow to pointers. The
 * fetch is bounded to note cap + {@link FEED_POINTER_CAP} rows plus one
 * sentinel row, so `truncated` is true only when exposed notes were
 * actually dropped. Zero matches resolve to empty lists, never an error.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project whose notes are resolved.
 * @param task - The task the feed targets.
 * @param budget - Optional caps; each clamps to [1, its default].
 * @returns Admitted rows and pointer-only overflow, most recently
 *   updated first, plus the truncation flag.
 * @throws ForbiddenError when the caller cannot access the project.
 */
export async function resolveExposedNotes(
  ctx: AuthContext,
  projectId: string,
  task: FeedTask,
  budget?: FeedBudget,
): Promise<NoteFeedResolution> {
  assertValidProjectId(projectId);
  const { maxNotes } = clampFeedBudget(budget);
  const fetchLimit = maxNotes + FEED_POINTER_CAP;
  const [gateRows, rowsRaw] = await withUserContextRead(ctx.userId, (read) => [
    projectAccessGateStmt(read, projectId),
    notesFeedStmt(read, projectId, task, maxNotes, fetchLimit + 1),
  ]);
  assertProjectGateRows(projectId, gateRows);
  const fetched =
    normalizeExecuteResult<NoteFeedRawRow>(rowsRaw).map(mapNoteFeedRow);
  const rows = fetched.slice(0, fetchLimit);
  const resolution = applyFeedBudget(rows, budget);
  return {
    ...resolution,
    truncated: resolution.truncated || fetched.length > fetchLimit,
  };
}

/**
 * Preview the impact of deleting a note: linked-row counts, no mutation.
 * One read batch: gate + four counts. Note-link counts join the other
 * endpoint and skip trashed notes so the preview matches what
 * {@link getNoteFull} renders.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @returns The note header and per-table link/revision counts.
 * @throws ForbiddenError when the caller cannot access the note.
 */
export async function deleteNotePreview(
  ctx: AuthContext,
  noteId: string,
): Promise<DeleteNotePreview> {
  assertValidNoteId(noteId);
  const countCol = sql<number>`count(*)`;
  const [gateRows, taskLinkRows, inRows, outRows, revisionRows] =
    await withUserContextRead(ctx.userId, (read) => [
      noteAccessGateStmt(read, noteId),
      read
        .select({ count: countCol })
        .from(noteTaskLinks)
        .where(eq(noteTaskLinks.noteId, noteId)),
      read
        .select({ count: countCol })
        .from(noteLinks)
        .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
        .where(
          and(eq(noteLinks.targetNoteId, noteId), isNull(notes.deletedAt)),
        ),
      read
        .select({ count: countCol })
        .from(noteLinks)
        .innerJoin(notes, eq(notes.id, noteLinks.targetNoteId))
        .where(
          and(eq(noteLinks.sourceNoteId, noteId), isNull(notes.deletedAt)),
        ),
      read
        .select({ count: countCol })
        .from(noteRevisions)
        .where(eq(noteRevisions.noteId, noteId)),
    ]);
  const gate = assertNoteGateRows(noteId, gateRows);
  return {
    note: { id: gate.id, title: gate.title, slug: gate.slug },
    taskLinks: Number(taskLinkRows[0]?.count ?? 0),
    incomingLinks: Number(inRows[0]?.count ?? 0),
    outgoingLinks: Number(outRows[0]?.count ?? 0),
    revisions: Number(revisionRows[0]?.count ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create a note. Slug is derived from the title and deduped under the
 * project advisory lock; a non-empty body derives links and snapshots
 * revision 1 in the same transaction. Access defaults are "open"
 * (`agentWritable=true, locked=false`) per the Notes spec — the DB column
 * default is false, so they are set explicitly.
 *
 * @param ctx - Resolved auth context.
 * @param input - Note fields; title and projectId required.
 * @returns Slim summary of the created note.
 * @throws ForbiddenError when the caller cannot access the project.
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteValidationError on any field cap violation.
 */
export async function createNote(
  ctx: AuthContext,
  input: CreateNoteInput,
): Promise<NoteSummary> {
  assertValidProjectId(input.projectId);
  assertTitleWithinCap(input.title);
  const body = input.body ?? "";
  assertBodyWithinCap(body);
  assertMetadataWithinCaps(input);
  const folder = normalizeFolder(input.folder ?? "");
  const visibility = input.visibility ?? "private";

  const created = await withUserContext(ctx.userId, async (tx) => {
    const access = await assertProjectAccessTx(tx, input.projectId);
    assertProjectWritable(access.project.status, access.project.identifier);
    await acquireProjectLock(tx, input.projectId);
    const base = slugifyTitle(input.title);
    const taken = await loadSlugNamespace(tx, input.projectId, base);
    const slug = nextFreeSlug(base, taken);

    const [note] = await tx
      .insert(notes)
      .values({
        projectId: input.projectId,
        title: input.title,
        slug,
        body,
        folder,
        type: input.type ?? "reference",
        visibility,
        summary: input.summary ?? "",
        tags: input.tags ?? [],
        category: input.category ?? null,
        agentWritable: true,
        locked: false,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      .returning(noteSummaryColumns);

    if (body !== "") {
      await replaceDerivedLinks(
        tx,
        note.id,
        input.projectId,
        access.project.identifier,
        body,
        true,
      );
      await insertRevisionWithPrune(
        tx,
        note.id,
        note.version,
        input.title,
        body,
        ctx.userId,
      );
    }
    if (visibility === "team") {
      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId: input.projectId,
          taskId: null,
          type: "note_created",
          targetRef: slug,
          summary: `created note "${summaryTitle(input.title)}"`,
        },
      ]);
    }
    return note;
  });

  emitNoteEvent(created.projectId, created.id, visibility, created.updatedAt);
  return created;
}

/**
 * Update a note's scalar fields and/or body under the `ifUpdatedAt`
 * compare-and-swap. Fields equal to their current values are dropped
 * after the locked re-read; a patch with no effective change is a no-op
 * (no `updatedAt` bump, activity event, or emit), keeping `updatedAt` a
 * faithful CAS token and tree-ETag source. A body change bumps `version`,
 * snapshots a revision (pruned to the retention cap), re-derives links,
 * and flips `embedding_status` to `stale` when the note is already in the
 * embedding pipeline. `slug` is never touched — slugs are stable once
 * assigned. Feed labels and feed task ids store deduplicated trimmed
 * lowercase with empties dropped, the canonical form the §7 exposure
 * arms match against. One locked read serves as both the access gate
 * and the CAS baseline
 * (`FOR UPDATE OF notes` through the projects join); it selects `body`
 * only when the patch carries one.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @param patch - Fields to change; unknown/protected keys are stripped.
 * @param ifUpdatedAt - Optional CAS precondition from a prior read.
 * @returns Slim summary of the updated note; a body change also carries
 *   the re-derived link context as `links`.
 * @throws ForbiddenError on inaccessible or trashed notes, or when a
 *   non-creator sets `visibility='private'` (the RLS WITH CHECK pins
 *   private rows to their creator; this pre-check keeps the rejection
 *   typed instead of a raw 42501).
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteLockedError when the note is locked and the patch does not
 *   carry `locked: false`; a locked note accepts a write only when it
 *   unlocks, though that unlock patch may bundle other field changes.
 * @throws NoteStaleWriteError when `ifUpdatedAt` mismatches, carrying the
 *   live `updatedAt` and `version`.
 * @throws NoteValidationError on cap violations or a malformed
 *   `ifUpdatedAt`.
 */
export async function updateNote(
  ctx: AuthContext,
  noteId: string,
  patch: NotePatch,
  ifUpdatedAt?: string,
): Promise<NoteSummary & { links?: NoteLinksRefresh }> {
  assertValidNoteId(noteId);
  const applied: NotePatch = {};
  for (const field of PATCHABLE_NOTE_FIELDS) {
    if (patch[field] !== undefined) {
      (applied as Record<string, unknown>)[field] = patch[field];
    }
  }
  for (const field of ["feedCategories", "feedTags", "feedTaskIds"] as const) {
    const values = applied[field];
    if (values !== undefined) applied[field] = canonicalizeFeedLabels(values);
  }
  if (applied.title !== undefined) assertTitleWithinCap(applied.title);
  if (applied.body !== undefined) assertBodyWithinCap(applied.body);
  assertMetadataWithinCaps(applied);
  if (applied.folder !== undefined) {
    applied.folder = normalizeFolder(applied.folder);
  }
  const ifUpdatedAtMs =
    ifUpdatedAt === undefined ? undefined : parseIfUpdatedAt(ifUpdatedAt);

  const result = await withUserContext(ctx.userId, async (tx) => {
    const needsBody = applied.body !== undefined;
    const [current] = await tx
      .select({
        id: notes.id,
        projectId: notes.projectId,
        slug: notes.slug,
        title: notes.title,
        folder: notes.folder,
        tags: notes.tags,
        type: notes.type,
        category: notes.category,
        summary: notes.summary,
        feedMode: notes.feedMode,
        feedCategories: notes.feedCategories,
        feedTags: notes.feedTags,
        feedTaskIds: notes.feedTaskIds,
        agentWritable: notes.agentWritable,
        locked: notes.locked,
        visibility: notes.visibility,
        version: notes.version,
        updatedAt: notes.updatedAt,
        embeddingStatus: notes.embeddingStatus,
        deletedAt: notes.deletedAt,
        createdBy: notes.createdBy,
        projectStatus: projects.status,
        projectIdentifier: projects.identifier,
        body: needsBody ? notes.body : sql<string>`''`,
      })
      .from(notes)
      .innerJoin(projects, eq(projects.id, notes.projectId))
      .where(eq(notes.id, noteId))
      .limit(1)
      .for("update", { of: notes });
    if (!current || current.deletedAt !== null) {
      throw new ForbiddenError("Forbidden", "note", noteId);
    }
    assertProjectWritable(current.projectStatus, current.projectIdentifier);
    if (applied.visibility === "private" && current.createdBy !== ctx.userId) {
      throw new ForbiddenError("Forbidden", "note", noteId);
    }
    if (current.locked && applied.locked !== false) {
      throw new NoteLockedError();
    }
    if (
      ifUpdatedAtMs !== undefined &&
      ifUpdatedAtMs !== current.updatedAt.getTime()
    ) {
      throw new NoteStaleWriteError(current.updatedAt, current.version);
    }
    const currentSummary = gateSummary(current);
    if (Object.keys(applied).length === 0) {
      return {
        summary: currentSummary,
        wasNoOp: true,
        visibility: current.visibility,
        links: undefined,
      };
    }

    const bodyChanged = needsBody && applied.body !== current.body;
    const changedFields = dropUnchangedFields(applied, current, bodyChanged);
    if (changedFields.length === 0) {
      return {
        summary: currentSummary,
        wasNoOp: true,
        visibility: current.visibility,
        links: undefined,
      };
    }
    const newVersion = bodyChanged ? current.version + 1 : current.version;
    const changes: Record<string, unknown> = {
      ...applied,
      updatedBy: ctx.userId,
      updatedAt: new Date(),
    };
    if (bodyChanged) {
      changes.version = newVersion;
      if (current.embeddingStatus !== "none") changes.embeddingStatus = "stale";
    }
    if (applied.visibility === "team" && current.visibility !== "team") {
      changes.shareRequestedBy = null;
    }

    const nextVisibility = applied.visibility ?? current.visibility;

    const [summary] = await tx
      .update(notes)
      .set(changes)
      .where(eq(notes.id, noteId))
      .returning(noteSummaryColumns);

    let links: NoteLinksRefresh | undefined;
    if (bodyChanged) {
      const newBody = applied.body ?? "";
      await insertRevisionWithPrune(
        tx,
        noteId,
        newVersion,
        applied.title ?? current.title,
        newBody,
        ctx.userId,
      );
      await replaceDerivedLinks(
        tx,
        noteId,
        current.projectId,
        current.projectIdentifier,
        newBody,
        false,
      );
      const mentionRows = await tx
        .select({
          taskId: noteTaskLinks.taskId,
          kind: noteTaskLinks.kind,
          sequenceNumber: tasks.sequenceNumber,
          identifier: projects.identifier,
          status: tasks.status,
          title: tasks.title,
        })
        .from(noteTaskLinks)
        .innerJoin(tasks, eq(tasks.id, noteTaskLinks.taskId))
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(eq(noteTaskLinks.noteId, noteId));
      const linksOut = await tx
        .select({
          id: notes.id,
          slug: notes.slug,
          title: notes.title,
          type: notes.type,
          folder: notes.folder,
          updatedAt: notes.updatedAt,
        })
        .from(noteLinks)
        .innerJoin(notes, eq(notes.id, noteLinks.targetNoteId))
        .where(
          and(eq(noteLinks.sourceNoteId, noteId), isNull(notes.deletedAt)),
        );
      links = { mentions: mentionRows.map(toNoteMention), linksOut };
    }
    if (nextVisibility === "team") {
      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId: current.projectId,
          taskId: null,
          type: "note_updated",
          targetRef: summary.slug,
          summary: `updated note "${summaryTitle(summary.title)}"`,
          metadata: { fields: changedFields, version: newVersion },
        },
      ]);
    }
    return { summary, wasNoOp: false, visibility: nextVisibility, links };
  });

  if (!result.wasNoOp) {
    emitNoteEvent(
      result.summary.projectId,
      result.summary.id,
      result.visibility,
      result.summary.updatedAt,
    );
  }
  return result.links
    ? { ...result.summary, links: result.links }
    : result.summary;
}

/**
 * Move one note into a folder.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @param folder - Destination folder path (`""` = root).
 * @returns Slim summary of the moved note.
 * @throws ForbiddenError on inaccessible or trashed notes.
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteValidationError when the folder path exceeds the cap.
 */
export async function moveNote(
  ctx: AuthContext,
  noteId: string,
  folder: string,
): Promise<NoteSummary> {
  assertValidNoteId(noteId);
  const dest = normalizeFolder(folder);

  const result = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertNoteAccessTx(tx, noteId);
    assertNoteLive(gate);
    assertProjectWritable(gate.projectStatus, gate.projectIdentifier);
    if (gate.folder === dest) {
      return {
        summary: gateSummary(gate),
        wasNoOp: true,
        visibility: gate.visibility,
      };
    }
    const [summary] = await tx
      .update(notes)
      .set({ folder: dest, updatedBy: ctx.userId, updatedAt: new Date() })
      .where(eq(notes.id, noteId))
      .returning(noteSummaryColumns);
    if (gate.visibility === "team") {
      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId: gate.projectId,
          taskId: null,
          type: "note_moved",
          targetRef: summary.slug,
          summary: `moved note "${summaryTitle(summary.title)}"`,
          metadata: { from: gate.folder, to: dest },
        },
      ]);
    }
    return { summary, wasNoOp: false, visibility: gate.visibility };
  });

  if (!result.wasNoOp) {
    emitNoteEvent(
      result.summary.projectId,
      result.summary.id,
      result.visibility,
      result.summary.updatedAt,
    );
  }
  return result.summary;
}

/**
 * Re-parent a folder and its whole subtree. Folders are not rows: one
 * UPDATE rewrites the `folder` prefix on every live descendant note.
 * Moving a folder into itself or a descendant is rejected. Passing
 * `newLeaf` replaces the folder's own name at the destination, so a
 * rename is a move to the same parent with a new leaf. The UPDATE
 * runs under the caller's RLS scope, so teammates' private notes in the
 * subtree are untouched and keep their old paths — a definer-privileged
 * bulk write would let members rewrite paths of notes they cannot see.
 * The activity event and project dispatch fire only when a team-visible
 * note actually moved.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param src - Folder path being moved (must be non-root).
 * @param destParent - New parent path (`""` = root).
 * @param newLeaf - Replacement folder name; defaults to `src`'s leaf.
 * @returns The destination path and how many notes moved.
 * @throws ForbiddenError when the caller cannot access the project.
 * @throws ProjectArchivedError when the project is archived.
 * @throws FolderCycleError when `destParent` is `src` or a descendant.
 * @throws NoteValidationError when a path fails normalization, `newLeaf`
 *   normalizes to empty, or the move would push any resulting path past
 *   the folder cap.
 */
export async function moveFolder(
  ctx: AuthContext,
  projectId: string,
  src: string,
  destParent: string,
  newLeaf?: string,
): Promise<{ dest: string; movedCount: number }> {
  assertValidProjectId(projectId);
  const srcPath = normalizeFolder(src);
  const destParentPath = normalizeFolder(destParent);
  if (srcPath === "") {
    throw new NoteValidationError("folder", "cannot move the root folder");
  }
  if (destParentPath === srcPath || destParentPath.startsWith(`${srcPath}/`)) {
    throw new FolderCycleError(srcPath, destParentPath);
  }
  const leaf =
    newLeaf === undefined
      ? (srcPath.split("/").at(-1) ?? srcPath)
      : normalizeFolder(newLeaf);
  if (leaf === "") {
    throw new NoteValidationError("folder", "folder name cannot be empty");
  }
  const dest = destParentPath === "" ? leaf : `${destParentPath}/${leaf}`;
  if (dest.length > FOLDER_MAX_CHARS) {
    throw new NoteValidationError(
      "folder",
      `folder exceeds ${FOLDER_MAX_CHARS} characters`,
    );
  }
  const growth = [...dest].length - [...srcPath].length;

  const moved = await withUserContext(ctx.userId, async (tx) => {
    const access = await assertProjectAccessTx(tx, projectId);
    assertProjectWritable(access.project.status, access.project.identifier);
    if (dest === srcPath) return { movedCount: 0, teamMoved: false };
    await acquireProjectLock(tx, projectId);
    const subtreeFilter = and(
      eq(notes.projectId, projectId),
      isNull(notes.deletedAt),
      or(
        eq(notes.folder, srcPath),
        like(notes.folder, `${escapeLike(srcPath)}/%`),
      ),
    );
    if (growth > 0) {
      const [row] = await tx
        .select({
          longest: sql<number | null>`MAX(char_length(${notes.folder}))`,
        })
        .from(notes)
        .where(subtreeFilter);
      if ((row?.longest ?? 0) + growth > FOLDER_MAX_CHARS) {
        throw new NoteValidationError(
          "folder",
          `move would push a descendant past ${FOLDER_MAX_CHARS} characters`,
        );
      }
    }
    const rows = await tx
      .update(notes)
      .set({
        folder: sql`${dest} || substr(${notes.folder}, char_length(${srcPath}::text) + 1)`,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      })
      .where(subtreeFilter)
      .returning({ id: notes.id, visibility: notes.visibility });
    const teamMoved = rows.some((row) => row.visibility === "team");
    if (teamMoved) {
      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId,
          taskId: null,
          type: "note_moved",
          targetRef: srcPath,
          summary: `moved folder "${srcPath}" to "${dest}"`,
          metadata: { src: srcPath, dest, count: rows.length },
        },
      ]);
    }
    return { movedCount: rows.length, teamMoved };
  });

  if (moved.teamMoved) emitProjectEvent(projectId);
  return { dest, movedCount: moved.movedCount };
}

/**
 * Soft-delete a note (sets `deleted_at`). Idempotent: deleting a trashed
 * note is a no-op. Links and revisions stay in place — read paths filter
 * trashed endpoints, and the FK cascade covers an eventual hard purge.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @returns The note id and its `deletedAt` instant.
 * @throws ForbiddenError when the caller cannot access the note.
 * @throws ProjectArchivedError when the project is archived.
 */
export async function deleteNote(
  ctx: AuthContext,
  noteId: string,
): Promise<{ id: string; deletedAt: Date }> {
  assertValidNoteId(noteId);
  const result = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertNoteAccessTx(tx, noteId);
    assertProjectWritable(gate.projectStatus, gate.projectIdentifier);
    if (gate.deletedAt !== null) {
      return { id: gate.id, deletedAt: gate.deletedAt, wasNoOp: true as const };
    }
    const [row] = await tx
      .update(notes)
      .set({
        deletedAt: new Date(),
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      })
      .where(eq(notes.id, noteId))
      .returning({ id: notes.id, deletedAt: notes.deletedAt });
    if (gate.visibility === "team") {
      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId: gate.projectId,
          taskId: null,
          type: "note_deleted",
          targetRef: gate.slug,
          summary: `trashed note "${summaryTitle(gate.title)}"`,
        },
      ]);
    }
    return {
      id: row.id,
      deletedAt: row.deletedAt as Date,
      wasNoOp: false as const,
      projectId: gate.projectId,
      visibility: gate.visibility,
    };
  });

  if (!result.wasNoOp && "projectId" in result) {
    emitNoteEvent(result.projectId, result.id, result.visibility);
  }
  return { id: result.id, deletedAt: result.deletedAt };
}

/**
 * Restore a trashed note. When a live note has since taken its slug, the
 * restored note is auto-suffixed within its base namespace under the
 * project advisory lock; a free slug is kept as-is. Idempotent on a live
 * note.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @returns Slim summary; `slug` may differ from before the delete.
 * @throws ForbiddenError when the caller cannot access the note.
 * @throws ProjectArchivedError when the project is archived.
 */
export async function restoreNote(
  ctx: AuthContext,
  noteId: string,
): Promise<NoteSummary> {
  assertValidNoteId(noteId);
  const result = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertNoteAccessTx(tx, noteId);
    assertProjectWritable(gate.projectStatus, gate.projectIdentifier);
    if (gate.deletedAt === null) {
      return {
        summary: gateSummary(gate),
        wasNoOp: true,
        visibility: gate.visibility,
      };
    }
    await acquireProjectLock(tx, gate.projectId);
    const [current] = await tx
      .select({ ...noteSummaryColumns, deletedAt: notes.deletedAt })
      .from(notes)
      .where(eq(notes.id, noteId))
      .for("update");
    if (!current) throw new ForbiddenError("Forbidden", "note", noteId);
    if (current.deletedAt === null) {
      const { deletedAt: _live, ...summary } = current;
      return { summary, wasNoOp: true, visibility: gate.visibility };
    }
    const base = slugifyTitle(current.title);
    const taken = await loadSlugNamespace(
      tx,
      gate.projectId,
      base,
      current.slug,
    );
    const slug = taken.has(current.slug)
      ? nextFreeSlug(base, taken)
      : current.slug;

    const [summary] = await tx
      .update(notes)
      .set({
        deletedAt: null,
        slug,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      })
      .where(eq(notes.id, noteId))
      .returning(noteSummaryColumns);
    if (gate.visibility === "team") {
      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId: gate.projectId,
          taskId: null,
          type: "note_restored",
          targetRef: slug,
          summary: `restored note "${summaryTitle(summary.title)}"`,
          metadata:
            slug === current.slug ? null : { previousSlug: current.slug },
        },
      ]);
    }
    return { summary, wasNoOp: false, visibility: gate.visibility };
  });

  if (!result.wasNoOp) {
    emitNoteEvent(
      result.summary.projectId,
      result.summary.id,
      result.visibility,
      result.summary.updatedAt,
    );
  }
  return result.summary;
}

/**
 * Record the acting user's request to share a private note with the
 * team. A pending request IS `share_requested_by` being non-null; there
 * is no separate boolean. The visibility flip itself is human-only
 * ({@link approveShareRequest}). No activity event is recorded: the note
 * is still private and the project-scoped feed would leak its title.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @returns Slim summary of the note.
 * @throws ForbiddenError on inaccessible or trashed notes.
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteShareStateError when the note is already team-visible.
 */
export async function requestShare(
  ctx: AuthContext,
  noteId: string,
): Promise<NoteSummary> {
  assertValidNoteId(noteId);
  const summary = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertNoteAccessTx(tx, noteId);
    assertNoteLive(gate);
    assertProjectWritable(gate.projectStatus, gate.projectIdentifier);
    if (gate.visibility === "team") {
      throw new NoteShareStateError("already_team");
    }
    const [row] = await tx
      .update(notes)
      .set({
        shareRequestedBy: ctx.userId,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      })
      .where(eq(notes.id, noteId))
      .returning(noteSummaryColumns);
    return row;
  });

  emitNoteEvent(summary.projectId, summary.id, "private", summary.updatedAt);
  return summary;
}

/**
 * Approve a pending share request: flips visibility to `team` and clears
 * the request marker. Human-path function (PYZ-255 server actions); the
 * MCP layer never routes agents here.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @returns Slim summary of the note.
 * @throws ForbiddenError on inaccessible or trashed notes.
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteLockedError when the note is locked.
 * @throws NoteShareStateError when no request is pending.
 */
export async function approveShareRequest(
  ctx: AuthContext,
  noteId: string,
): Promise<NoteSummary> {
  assertValidNoteId(noteId);
  const summary = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertNoteAccessTx(tx, noteId);
    assertNoteLive(gate);
    assertProjectWritable(gate.projectStatus, gate.projectIdentifier);
    if (gate.locked) throw new NoteLockedError();
    if (gate.shareRequestedBy === null) {
      throw new NoteShareStateError("no_pending_request");
    }
    return applyVisibilityTx(tx, ctx, gate, "team");
  });

  emitNoteEvent(summary.projectId, summary.id, "team", summary.updatedAt);
  return summary;
}

/**
 * Decline a pending share request: clears the `shareRequestedBy` marker
 * while the note stays private. The counterpart to
 * {@link approveShareRequest} for the ribbon's "Keep private" action; no
 * other shipped path clears the marker without a visibility flip
 * ({@link NotePatch} omits the field). Human-path function; the MCP layer
 * never routes agents here. No activity event: the note stays private, so
 * a feed row would leak its title (the same reason {@link requestShare}
 * records none). The realtime emit rides the creator-only `note:<id>`
 * channel, so the banner clears in the creator's other sessions without
 * a project-wide signal.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @returns Slim summary of the note.
 * @throws ForbiddenError on inaccessible or trashed notes.
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteLockedError when the note is locked.
 * @throws NoteShareStateError when no request is pending.
 */
export async function declineShareRequest(
  ctx: AuthContext,
  noteId: string,
): Promise<NoteSummary> {
  assertValidNoteId(noteId);
  const summary = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertNoteAccessTx(tx, noteId);
    assertNoteLive(gate);
    assertProjectWritable(gate.projectStatus, gate.projectIdentifier);
    if (gate.locked) throw new NoteLockedError();
    if (gate.shareRequestedBy === null) {
      throw new NoteShareStateError("no_pending_request");
    }
    const [row] = await tx
      .update(notes)
      .set({
        shareRequestedBy: null,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      })
      .where(eq(notes.id, gate.id))
      .returning(noteSummaryColumns);
    return row;
  });

  emitNoteEvent(summary.projectId, summary.id, "private", summary.updatedAt);
  return summary;
}

/**
 * Shared visibility write: updates the column, clears the share-request
 * marker when flipping to `team`, and records the activity event.
 *
 * @param tx - Active RLS transaction handle.
 * @param ctx - Resolved auth context.
 * @param gate - The note's access-gate row.
 * @param visibility - Target visibility.
 * @returns Slim summary of the note.
 */
async function applyVisibilityTx(
  tx: Tx,
  ctx: AuthContext,
  gate: NoteAccessGate,
  visibility: Visibility,
): Promise<NoteSummary> {
  const [row] = await tx
    .update(notes)
    .set({
      visibility,
      ...(visibility === "team" ? { shareRequestedBy: null } : {}),
      updatedBy: ctx.userId,
      updatedAt: new Date(),
    })
    .where(eq(notes.id, gate.id))
    .returning(noteSummaryColumns);
  await insertActivityEvents(tx, ctx.actor, [
    {
      projectId: gate.projectId,
      taskId: null,
      type: "note_updated",
      targetRef: row.slug,
      summary: `updated note "${summaryTitle(row.title)}"`,
      metadata: { fields: ["visibility"], version: row.version },
    },
  ]);
  return row;
}
