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
 * Agent-facing policy: `locked` gates every writer ({@link updateNote},
 * move, delete, deliberate links, and the share transitions), so a locked
 * note is read-only for humans and agents alike until an unlock patch
 * (`locked: false`) lands.
 * `agent_writable` gates every mutation for MCP actors only
 * (`ctx.actor.source === 'mcp'` throws {@link NoteAgentReadOnlyError});
 * web and system actors are untouched. The agent ban on setting
 * `visibility='team'` is structural — the MCP tool schema carries no
 * visibility field and `request_share` is the sanctioned agent path.
 * Human server actions call these functions directly.
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
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import type { AuthContext } from "@/lib/auth/context";
import {
  assertNoteAccessTx,
  assertNoteGateRows,
  assertProjectAccessTx,
  assertProjectGateRows,
  assertTaskAccessTx,
  assertValidNoteId,
  assertValidProjectId,
  assertValidTaskId,
  firstRowOrForbidden,
  ForbiddenError,
  isUuid,
} from "@/lib/auth/authorization";
import {
  noteAccessGateStmt,
  projectAccessGateStmt,
  type NoteAccessGate,
} from "@/lib/data/access";
import { insertActivityEvents } from "@/lib/data/activity";
import { escapeRegExp, extractNoteRefs } from "@/lib/data/note-parse";
import {
  NOTE_BODY_MAX_CHARS,
  NOTE_FOLDER_MAX_CHARS,
  NOTE_TITLE_MAX_BYTES,
  noteFeedTasks,
  noteFolders,
  noteLinks,
  noteRevisions,
  notes,
  noteTaskLinks,
  projects,
  tasks,
  type Note,
} from "@/lib/db/schema";
import { normalizeFolderPath } from "@/lib/ui/note-folders";
import {
  executeRaw,
  normalizeExecuteResult,
  toDate,
  type ReadConn,
} from "@/lib/db/raw";
import { acquireProjectLock } from "@/lib/db/raw/acquire-project-lock";
import { noteUpdaterNameStmt } from "@/lib/db/raw/fetch-note-updater";
import {
  noteFoldersVersionStmt,
  type NoteFoldersVersionRow,
} from "@/lib/db/raw/get-note-folders-version";
import {
  notesTreeVersionStmt,
  type NotesTreeVersionRow,
} from "@/lib/db/raw/get-notes-max-updated-at";
import {
  notesFeedForTaskStmt,
  notesFeedStmt,
  type FeedTask,
  type NoteFeedBodyBound,
  type NoteFeedRawRow,
} from "@/lib/db/raw/notes-feed";
import {
  noteRefSearchStmt,
  noteSearchStmt,
  noteSubstringSearchStmt,
  type NoteSearchRawRow,
} from "@/lib/db/raw/search-notes";
import { dbClockStamp } from "@/lib/db/clock";
import { withUserContext, withUserContextRead, type Tx } from "@/lib/db/rls";
import { seqInRange } from "@/lib/data/resolve-ref";
import { BatchInputError } from "@/lib/data/task-batch";
import { InvalidEditOpError } from "@/lib/data/task-edit";
import { foldTextOp, type TextOp } from "@/lib/data/text-ops";
import { ProjectArchivedError } from "@/lib/graph/errors";
import {
  asIdentifier,
  composeNoteRef,
  composeTaskRef,
  NOTE_REF_PATTERN,
  NOTE_SEQ_TOKEN_PATTERN,
  REF_FRAGMENT_PATTERN,
} from "@/lib/graph/identifier";
import {
  emitNoteEvent,
  emitNoteEventsBatch,
  emitNoteFoldersEvent,
  emitProjectEvent,
  purgeNoteChannel,
} from "@/lib/realtime/events";
import {
  NOTE_SUMMARY_MAX_CHARS,
  NOTE_TASK_LINK_KIND_RANK,
  type FeedMode,
  type NoteTaskLinkKind,
  type NoteType,
  type TaskStatus,
  type Visibility,
} from "@/lib/types";

/** Revisions kept per note; older rows are pruned in the write tx. */
const NOTE_REVISION_KEEP = 50;

/**
 * Same-author quiet window between revision checkpoints. A body write
 * archives the pre-image only when the newest snapshot is at least this
 * old; MCP writes, a change of author, and restores checkpoint
 * unconditionally.
 */
const NOTE_REVISION_CHECKPOINT_MS = 10 * 60_000;

/** Pre-image snapshot descriptor a body-changing write archived, when it did. */
export type NoteRevisionCheckpoint = {
  version: number;
  title: string;
  createdAt: Date;
};

/** Byte cap for generated slugs; leaves suffix headroom under the CHECK. */
const SLUG_MAX_BYTES = 240;

/** Char cap for a search query string. */
const SEARCH_QUERY_MAX_CHARS = 256;

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
  | "version"
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

/**
 * Thrown when an MCP actor writes to a note with `agent_writable=false`.
 * Reads stay allowed; a human grants agent access in the note's ribbon.
 * Web and system actors never hit this gate.
 */
export class NoteAgentReadOnlyError extends Error {
  constructor() {
    super("Note is read-only to agents.");
    this.name = "NoteAgentReadOnlyError";
  }
}

/**
 * Thrown by {@link createNotesBatch} with `onDuplicate='error'` when any
 * batch item collides with an existing live note's (folder, title) pair.
 */
export class DuplicateNoteTitleError extends Error {
  /**
   * @param titles - The colliding titles.
   */
  constructor(public readonly titles: string[]) {
    super(`Note title(s) already exist: ${titles.join(", ")}`);
    this.name = "DuplicateNoteTitleError";
  }
}

/**
 * Thrown by {@link createNoteTaskLink} when the note and the task belong
 * to different projects; the DB trigger would reject the row anyway, this
 * pre-check keeps the rejection typed.
 */
export class CrossProjectNoteLinkError extends Error {
  constructor() {
    super("Cannot link a note to a task in a different project.");
    this.name = "CrossProjectNoteLinkError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Slim tree-list row; never carries `body` or `search_tsv`. `category` is
 * optional: the tree list projects it for client-side category grouping;
 * the search-hit path leaves it undefined (hits render flat by relevance).
 */
export type NoteTreeRow = {
  id: string;
  slug: string;
  sequenceNumber: number;
  title: string;
  type: NoteType;
  folder: string;
  category?: string | null;
  summary: string;
  visibility: Visibility;
  feedMode: FeedMode;
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
  sequenceNumber: number;
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

/** Full note row minus the server-side columns no client reads:
 *  `search_tsv`, `shared_since` (RLS fence state), and `meta_updated_at`
 *  (graph-ETag clock), plus the join-derived feed task selectors. */
export type NoteFull = Omit<
  Note,
  "searchTsv" | "sharedSince" | "metaUpdatedAt"
> & {
  /** Feed task selector ids, read from the `note_feed_tasks` join. */
  feedTaskIds: string[];
};

/** Single-note read: the full row plus its derived link context. */
export type NoteFullResult = {
  note: NoteFull;
  projectIdentifier: string;
  /** Last editor's org-visible display name, or null when unresolvable. */
  updatedByName: string | null;
  /** Whether the last edit came from the updater's agent (MCP actor). */
  updatedByAgent: boolean;
  mentions: NoteMention[];
  linksOut: LinkedNoteSlim[];
  linksIn: LinkedNoteSlim[];
};

/** One ranked search hit: the slim tree row, never the body. */
export type NoteSearchHit = NoteTreeRow;

export type { FeedTask };

/**
 * Agent-exposed note row. `body` is non-empty only for guidance rows
 * returned by the bodies variant of the feed query, char-bounded
 * server-side; `search_tsv` is never selected. `noteRef` is the composed
 * `<IDENT>-N<seq>` reference.
 */
export type NoteFeedRow = {
  id: string;
  slug: string;
  title: string;
  type: NoteType;
  folder: string;
  summary: string;
  body: string;
  /**
   * Codepoints the body charges against the feed budget. Equals
   * `charLen(body)` when the body shipped; on the `lengthsOnly` variant the
   * body stays in Postgres and only this count crosses the wire.
   */
  bodyChars: number;
  sequenceNumber: number;
  noteRef: string;
  updatedAt: Date;
};

/**
 * Pointer to an exposed note that overflowed the feed budget, or to an
 * explicitly linked note. `summary` is carried only by linked pointers;
 * overflow pointers omit it and render title-only.
 */
export type NoteFeedPointer = {
  id: string;
  slug: string;
  title: string;
  type: NoteType;
  sequenceNumber: number;
  noteRef: string;
  summary?: string;
};

/**
 * Budgeted feed resolution: admitted rows plus overflow pointers.
 * `truncated` is true when exposed notes beyond the fetch or pointer
 * bound were dropped, so the pointer list may be incomplete. `linked`
 * carries notes reached through a `note_task_links` backlink of any kind
 * (spec_of/reference/mention) rather than the feed, rendered as pointers;
 * the bundle path folds them in, standalone feed reads leave it empty.
 */
export type NoteFeedResolution = {
  notes: NoteFeedRow[];
  overflow: NoteFeedPointer[];
  linked: NoteFeedPointer[];
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

/**
 * Explicit folder paths plus their cache validator, returned together so
 * the folders route derives its ETag without a second round trip.
 */
export type NoteFoldersList = {
  paths: string[];
  version: { maxCreatedAt: Date | null; count: number };
};

/**
 * Slim write-result shape returned by every note mutation.
 * `sequenceNumber` + `projectIdentifier` let callers compose the noteRef
 * (`PYZ-N12`) without a second query.
 */
export type NoteSummary = {
  id: string;
  slug: string;
  sequenceNumber: number;
  title: string;
  projectId: string;
  projectIdentifier: string;
  folder: string;
  version: number;
  updatedAt: Date;
  updatedBy: string | null;
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
  feedMode?: FeedMode;
  feedCategories?: string[];
  feedTags?: string[];
  feedTaskIds?: string[];
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

/**
 * Summary projection shared by every write's `.returning()`.
 * `projectIdentifier` cannot ride a `.returning()` (it lives on the
 * projects join), so each write composes it from its gate row.
 */
const noteSummaryColumns = {
  id: notes.id,
  slug: notes.slug,
  sequenceNumber: notes.sequenceNumber,
  title: notes.title,
  projectId: notes.projectId,
  folder: notes.folder,
  version: notes.version,
  updatedAt: notes.updatedAt,
  updatedBy: notes.updatedBy,
} as const;

/** Slim tree-list projection; excludes `body` and `search_tsv` by design. */
const noteTreeColumns = {
  id: notes.id,
  slug: notes.slug,
  sequenceNumber: notes.sequenceNumber,
  title: notes.title,
  type: notes.type,
  folder: notes.folder,
  category: notes.category,
  summary: notes.summary,
  visibility: notes.visibility,
  feedMode: notes.feedMode,
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

/**
 * Scalar projection for field reads that touch no large column: every
 * `noteFullColumns` entry except `body`, so a scalar read skips the body
 * detoast and transfer.
 */
const { body: _body, ...noteScalarColumns } = noteFullColumns;

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
 * Escape LIKE pattern metacharacters so user-derived values match
 * literally.
 *
 * @param value - Literal string destined for a LIKE pattern.
 * @returns The string with `\`, `%`, and `_` escaped.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Build the "self or descendant of `srcPath`" predicate over a folder-path
 * column. Shared by the move-folder and delete-folder subtree filters so the
 * LIKE-escape stays identical across both.
 *
 * @param column - Folder-path column (`notes.folder` or `noteFolders.path`).
 * @param srcPath - Normalized subtree root.
 * @returns SQL predicate matching the path itself or any descendant.
 */
function folderSubtreePredicate(column: AnyColumn, srcPath: string): SQL {
  return or(eq(column, srcPath), like(column, `${escapeLike(srcPath)}/%`))!;
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
 * Normalize a folder path and enforce the length cap. Segment normalization
 * is the shared {@link normalizeFolderPath}; the cap is measured in code
 * points to match the `char_length` DB CHECK.
 *
 * @param raw - Caller-supplied folder path.
 * @returns Canonical path (`""` = root).
 * @throws NoteValidationError when the normalized path exceeds the cap.
 */
export function normalizeFolder(raw: string): string {
  const folder = normalizeFolderPath(raw);
  if ([...folder].length > NOTE_FOLDER_MAX_CHARS) {
    throw new NoteValidationError(
      "folder",
      `folder exceeds ${NOTE_FOLDER_MAX_CHARS} characters`,
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
    fields.summary.length > NOTE_SUMMARY_MAX_CHARS
  ) {
    throw new NoteValidationError(
      "summary",
      `summary exceeds ${NOTE_SUMMARY_MAX_CHARS} characters`,
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
 * Reject MCP-actor writes against an agent-read-only note. Spec §9.2:
 * `agent_writable` is an actor rule, not a tenant rule, so it lives here
 * (one choke point per write, zero extra reads) rather than in RLS or
 * per-handler gate fetches. Creation and `requestShare` are exempt.
 *
 * @param ctx - Resolved auth context.
 * @param agentWritable - The note's `agent_writable` column value.
 * @throws NoteAgentReadOnlyError when an MCP actor writes a read-only note.
 */
function assertAgentWritable(ctx: AuthContext, agentWritable: boolean): void {
  if (ctx.actor.source === "mcp" && !agentWritable) {
    throw new NoteAgentReadOnlyError();
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
    | "id"
    | "slug"
    | "sequenceNumber"
    | "title"
    | "projectId"
    | "projectIdentifier"
    | "folder"
    | "version"
    | "updatedAt"
    | "updatedBy"
  >,
): NoteSummary {
  return {
    id: gate.id,
    slug: gate.slug,
    sequenceNumber: gate.sequenceNumber,
    title: gate.title,
    projectId: gate.projectId,
    projectIdentifier: gate.projectIdentifier,
    folder: gate.folder,
    version: gate.version,
    updatedBy: gate.updatedBy,
    updatedAt: gate.updatedAt,
  };
}

/** Patch fields compared by JSON value rather than identity. */
const JSON_PATCH_FIELDS = new Set<keyof NotePatch>([
  "tags",
  "feedCategories",
  "feedTags",
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
  current: Pick<Note, Exclude<keyof NotePatch, "body" | "feedTaskIds">>,
  bodyChanged: boolean,
): string[] {
  for (const field of Object.keys(applied) as (keyof NotePatch)[]) {
    if (field === "body") {
      if (!bodyChanged) delete applied.body;
      continue;
    }
    // feedTaskIds is stripped from `applied` before this runs (it writes to
    // the join, not the notes column) and is never compared here.
    if (field === "feedTaskIds") continue;
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
 * Compare two id collections as sets.
 *
 * @param next - Newly derived ids (may contain duplicates).
 * @param current - Existing ids.
 * @returns True when both contain exactly the same ids.
 */
function sameIdSet(
  next: readonly string[],
  current: readonly string[],
): boolean {
  const a = new Set(next);
  const b = new Set(current);
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Re-derive a note's body-driven links inside the body-write transaction.
 * Deletes then reinserts ONLY the derivation-owned rows: `note_task_links`
 * with `kind='mention'` (user-managed `reference`/`spec_of` rows survive)
 * and the note's outgoing `note_links` (incoming rows belong to other
 * notes' derivations). Note links resolve from both `[[Title]]` and the
 * stable `[[<IDENTIFIER>-N<seq>]]` ref form, unioned and deduped so one row
 * covers a note referenced both ways. Unresolved refs are not stored; RLS
 * hides other members' private notes from the lookup, so derivation can
 * never link to a note the author cannot see.
 *
 * When the derived set matches the stored rows the rewrite is skipped
 * entirely — unchanged bodies stop churning link rows, and the return
 * value tells the caller whether the graph-visible link set moved (the
 * `meta_updated_at` bump trigger).
 *
 * @param tx - Active RLS transaction handle.
 * @param noteId - Source note id.
 * @param projectId - Owning project id.
 * @param projectIdentifier - Identifier task and note refs are parsed against.
 * @param body - The new note body.
 * @param isNew - Skip the scoped deletes for a freshly inserted note.
 * @returns True when the stored derivation-owned link set changed.
 */
async function replaceDerivedLinks(
  tx: Tx,
  noteId: string,
  projectId: string,
  projectIdentifier: string,
  body: string,
  isNew: boolean,
): Promise<boolean> {
  const { taskSeqs, noteSeqs, titles } = extractNoteRefs(
    body,
    projectIdentifier,
  );

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

  const targetNoteIdSet = new Set<string>();
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
    for (const row of rows) targetNoteIdSet.add(row.id);
  }
  if (noteSeqs.length > 0) {
    const rows = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(
          eq(notes.projectId, projectId),
          isNull(notes.deletedAt),
          ne(notes.id, noteId),
          inArray(notes.sequenceNumber, noteSeqs),
        ),
      );
    for (const row of rows) targetNoteIdSet.add(row.id);
  }
  const targetNoteIds = [...targetNoteIdSet];

  if (!isNew) {
    const [currentMentions, currentOut] = await Promise.all([
      tx
        .select({ taskId: noteTaskLinks.taskId })
        .from(noteTaskLinks)
        .where(
          and(
            eq(noteTaskLinks.noteId, noteId),
            eq(noteTaskLinks.kind, "mention"),
          ),
        ),
      tx
        .select({ targetNoteId: noteLinks.targetNoteId })
        .from(noteLinks)
        .where(eq(noteLinks.sourceNoteId, noteId)),
    ]);
    if (
      sameIdSet(
        taskIds,
        currentMentions.map((r) => r.taskId),
      ) &&
      sameIdSet(
        targetNoteIds,
        currentOut.map((r) => r.targetNoteId),
      )
    ) {
      return false;
    }
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
  return !isNew || taskIds.length > 0 || targetNoteIds.length > 0;
}

/**
 * Replace a note's `note_feed_tasks` rows with `nextIds`, filtered to
 * same-project live tasks. The filter is what keeps the FK from ever
 * rejecting a dangling or cross-project id (mirrors the "unresolved refs
 * not stored" rule for note links). When the filtered set already matches
 * the stored rows the rewrite is skipped and `false` is returned, so a
 * no-op feed edit does not churn rows or move the note's clocks. A new
 * note has no stored rows, so `isNew` skips the current-set read and the
 * delete (mirrors {@link replaceDerivedLinks}).
 *
 * Runs in the note-write transaction so the join writes see the RLS GUC.
 *
 * @param tx - Active RLS transaction handle.
 * @param noteId - Note whose feed-task set is replaced.
 * @param projectId - Owning project; the same-project filter scope.
 * @param nextIds - Desired feed-task ids (may contain dangling/foreign ids).
 * @param isNew - True when the note was created in this transaction.
 * @returns True when the stored feed-task set changed.
 */
async function replaceFeedTaskLinks(
  tx: Tx,
  noteId: string,
  projectId: string,
  nextIds: readonly string[],
  isNew: boolean,
): Promise<boolean> {
  const desired = [...new Set(nextIds)];
  let liveIds: string[] = [];
  if (desired.length > 0) {
    const rows = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), inArray(tasks.id, desired)));
    liveIds = rows.map((row) => row.id);
  }

  if (!isNew) {
    const current = await tx
      .select({ taskId: noteFeedTasks.taskId })
      .from(noteFeedTasks)
      .where(eq(noteFeedTasks.noteId, noteId));
    if (
      sameIdSet(
        liveIds,
        current.map((row) => row.taskId),
      )
    ) {
      return false;
    }
    await tx.delete(noteFeedTasks).where(eq(noteFeedTasks.noteId, noteId));
  }

  if (liveIds.length > 0) {
    await tx
      .insert(noteFeedTasks)
      .values(liveIds.map((taskId) => ({ noteId, taskId })));
  }
  return !isNew || liveIds.length > 0;
}

/**
 * Read a note's selected feed-task ids from the `note_feed_tasks` join as
 * a lazy statement, for batching into the full/scalar note reads that
 * surface {@link NoteFull.feedTaskIds}.
 *
 * @param read - Read statement-building handle.
 * @param noteId - Note whose feed-task ids are read.
 * @returns Lazy select yielding one `{ taskId }` row per join row.
 */
function noteFeedTaskIdsStmt(read: ReadConn, noteId: string) {
  return read
    .select({ taskId: noteFeedTasks.taskId })
    .from(noteFeedTasks)
    .where(eq(noteFeedTasks.noteId, noteId));
}

/**
 * Snapshot a note body into `note_revisions` and prune past the retention
 * cap. Runs in the body-write transaction; `created_by` must be the caller
 * or NULL (the table's RLS WITH CHECK pin), and DELETE (not UPDATE) is the
 * grant the prune relies on.
 *
 * @param tx - Active RLS transaction handle.
 * @param noteId - Note id.
 * @param version - Revision counter value being snapshotted.
 * @param title - Note title at this revision.
 * @param body - Note body at this revision.
 * @param userId - `created_by` attribution: the caller when they authored
 *   the snapshotted content, NULL when archiving another author's state.
 * @param createdAt - Snapshot timestamp; pre-image checkpoints pass the
 *   note's pre-write `updatedAt` so the row dates the content, not the
 *   archive write. Defaults to DB `now()`.
 */
async function insertRevisionWithPrune(
  tx: Tx,
  noteId: string,
  version: number,
  title: string,
  body: string,
  userId: string | null,
  createdAt?: Date,
): Promise<void> {
  await tx.insert(noteRevisions).values({
    noteId,
    version,
    title,
    body,
    createdBy: userId,
    ...(createdAt !== undefined ? { createdAt } : {}),
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
 * `note_task_links_task_id_idx`. Batch alongside a task-gating read and
 * evaluate the gate first, as {@link getTaskNoteContext} does. The `id`
 * tiebreak keeps row order deterministic across identical reads: the
 * task-notes route hashes the serialized payload into its ETag, so an
 * order flip on unchanged data would break conditional 304s.
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
    })
    .from(noteTaskLinks)
    .innerJoin(notes, eq(notes.id, noteTaskLinks.noteId))
    .where(and(eq(noteTaskLinks.taskId, taskId), isNull(notes.deletedAt)))
    .orderBy(notes.title, noteTaskLinks.kind, notes.id);
}

/** Pointer row from {@link taskBacklinkPointersStmt}. */
export type TaskBacklinkPointerRow = {
  id: string;
  slug: string;
  sequenceNumber: number;
  title: string;
  type: NoteType;
  summary: string;
  identifier: string;
};

/**
 * Build the agent-facing task-backlinks read: live, team-visible notes
 * linked to the task via `note_task_links` under any kind
 * (spec_of/reference/mention), projected to pointer fields plus the
 * summary and the project identifier for the noteRef. Unlike
 * {@link taskNoteBacklinksStmt} (the human web read, which returns a
 * member's own private notes too), this enforces `visibility = 'team'`
 * so a private linked note never reaches an agent bundle, the same fence
 * the feed query applies. Feed mode is irrelevant here: a backlink
 * surfaces the note regardless of `feed_mode`. A note linked under
 * several kinds yields one row per kind; {@link foldBacklinkPointers}
 * dedupes to one pointer. Batch it into the bundle's feed read; the
 * extra statement adds no round trip.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the task.
 * @returns Lazy select statement yielding {@link TaskBacklinkPointerRow}s.
 */
export function taskBacklinkPointersStmt(read: ReadConn, taskId: string) {
  return read
    .select({
      id: notes.id,
      slug: notes.slug,
      sequenceNumber: notes.sequenceNumber,
      title: notes.title,
      type: notes.type,
      summary: notes.summary,
      identifier: projects.identifier,
    })
    .from(noteTaskLinks)
    .innerJoin(notes, eq(notes.id, noteTaskLinks.noteId))
    .innerJoin(projects, eq(projects.id, notes.projectId))
    .where(
      and(
        eq(noteTaskLinks.taskId, taskId),
        isNull(notes.deletedAt),
        eq(notes.visibility, "team"),
      ),
    )
    .orderBy(notes.title);
}

/**
 * Fold task-backlink rows into a feed resolution as `linked` pointers:
 * notes reached through a `note_task_links` backlink of any kind
 * (spec_of/reference/mention), deduped against feed-injected notes and
 * overflow so a note that both feeds and is linked lists once, and by id
 * so a note linked under several kinds lists once. Each carries its
 * summary; rendered under Relevant Notes as pointers regardless of type,
 * and a backlink never injects a body.
 *
 * @param resolution - The budgeted feed resolution to extend.
 * @param backlinks - Backlink pointer rows from
 *   {@link taskBacklinkPointersStmt}.
 * @returns The resolution with `linked` populated.
 */
export function foldBacklinkPointers(
  resolution: NoteFeedResolution,
  backlinks: readonly TaskBacklinkPointerRow[],
): NoteFeedResolution {
  if (backlinks.length === 0) return resolution;
  const seen = new Set<string>();
  for (const note of resolution.notes) seen.add(note.id);
  for (const pointer of resolution.overflow) seen.add(pointer.id);
  const linked: NoteFeedPointer[] = [];
  for (const row of backlinks) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    linked.push({
      id: row.id,
      slug: row.slug,
      title: row.title,
      type: row.type,
      sequenceNumber: row.sequenceNumber,
      noteRef: composeNoteRef(asIdentifier(row.identifier), row.sequenceNumber),
      summary: row.summary,
    });
  }
  return { ...resolution, linked };
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
      sequenceNumber: notes.sequenceNumber,
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
 * Read the tree-list cache validator: latest live `meta_updated_at` plus
 * the live-row count (the count catches soft deletes MAX alone misses).
 * The metadata clock keeps body-only autosaves off the validator.
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
 * List a project's explicit folder paths with their cache validator.
 * ONE read batch: project gate + ordered paths + version.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Paths ordered by path plus the ETag validator pair.
 * @throws ForbiddenError when the caller cannot access the project.
 */
export async function listNoteFolderPaths(
  ctx: AuthContext,
  projectId: string,
): Promise<NoteFoldersList> {
  assertValidProjectId(projectId);
  const [gateRows, pathRows, versionRaw] = await withUserContextRead(
    ctx.userId,
    (read) => [
      projectAccessGateStmt(read, projectId),
      read
        .select({ path: noteFolders.path })
        .from(noteFolders)
        .where(eq(noteFolders.projectId, projectId))
        .orderBy(asc(noteFolders.path)),
      noteFoldersVersionStmt(read, projectId),
    ],
  );
  assertProjectGateRows(projectId, gateRows);
  const [row] = normalizeExecuteResult<NoteFoldersVersionRow>(versionRaw);
  const max = row?.max_created_at ?? null;
  return {
    paths: pathRows.map((r) => r.path),
    version: {
      maxCreatedAt: max === null ? null : toDate(max),
      count: Number(row?.live_count ?? 0),
    },
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
  const [
    gateRows,
    noteRows,
    feedTaskRows,
    mentionRows,
    linksOut,
    linksIn,
    updaterRows,
  ] = await withUserContextRead(ctx.userId, (read) => [
    noteAccessGateStmt(read, noteId),
    noteRowStmt(read, noteId),
    noteFeedTaskIdsStmt(read, noteId),
    noteMentionsStmt(read, noteId),
    noteLinksOutStmt(read, noteId),
    noteLinksInStmt(read, noteId),
    noteUpdaterNameStmt(read, noteId),
  ]);
  const gate = assertNoteGateRows(noteId, gateRows);
  const [note] = noteRows;
  if (!note) throw new ForbiddenError("Forbidden", "note", noteId);
  const [updater] = normalizeExecuteResult<{
    name: string | null;
    is_agent: boolean;
  }>(updaterRows);
  return {
    note: { ...note, feedTaskIds: feedTaskRows.map((row) => row.taskId) },
    projectIdentifier: gate.projectIdentifier,
    updatedByName: updater?.name ?? null,
    updatedByAgent: updater?.is_agent ?? false,
    mentions: mentionRows.map(toNoteMention),
    linksOut,
    linksIn,
  };
}

/**
 * Body-less scalar read: the note's scalar columns with `body`, mentions,
 * and links empty, for field reads that touch no large column. Body and
 * links fields must route to {@link getNoteFull}; this skips the body
 * detoast and transfer. Same result shape as {@link getNoteFull}, so
 * scalar-field rendering is shared.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @returns Full-shaped result with an empty `body` and no link context.
 * @throws ForbiddenError on inaccessible or trashed notes.
 */
export async function getNoteScalarFields(
  ctx: AuthContext,
  noteId: string,
): Promise<NoteFullResult> {
  assertValidNoteId(noteId);
  const [gateRows, noteRows, feedTaskRows] = await withUserContextRead(
    ctx.userId,
    (read) => [
      noteAccessGateStmt(read, noteId),
      read
        .select(noteScalarColumns)
        .from(notes)
        .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
        .limit(1),
      noteFeedTaskIdsStmt(read, noteId),
    ],
  );
  const gate = assertNoteGateRows(noteId, gateRows);
  const [row] = noteRows;
  if (!row) throw new ForbiddenError("Forbidden", "note", noteId);
  return {
    note: {
      ...row,
      body: "",
      feedTaskIds: feedTaskRows.map((r) => r.taskId),
    },
    projectIdentifier: gate.projectIdentifier,
    updatedByName: null,
    updatedByAgent: false,
    mentions: [],
    linksOut: [],
    linksIn: [],
  };
}

/**
 * Resolve feed task ids to taskRefs for a ref-first render. One
 * `tasks JOIN projects` read, RLS-scoped; ids with no visible row are
 * absent from the map, and the caller falls back to the raw UUID.
 *
 * @param ctx - Resolved auth context.
 * @param taskIds - Feed task UUIDs.
 * @returns Map from task id to composed taskRef.
 */
export async function composeFeedTaskRefs(
  ctx: AuthContext,
  taskIds: string[],
): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();
  const [rows] = await withUserContextRead(ctx.userId, (read) => [
    read
      .select({
        id: tasks.id,
        identifier: projects.identifier,
        sequenceNumber: tasks.sequenceNumber,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(inArray(tasks.id, taskIds)),
  ]);
  return new Map(
    rows.map((r) => [
      r.id,
      String(composeTaskRef(asIdentifier(r.identifier), r.sequenceNumber)),
    ]),
  );
}

/**
 * Parse a ref-shaped query into an exact note lookup key.
 *
 * @param query - Trimmed search text.
 * @returns The uppercase project prefix and the in-range sequence number,
 *   or null when the text is not ref-shaped or names a sequence no note
 *   can carry (outside the int4 column range).
 */
function matchNoteRef(query: string): { prefix: string; seq: number } | null {
  const match = query.match(NOTE_REF_PATTERN);
  if (match === null) return null;
  const seq = seqInRange(match[2]);
  if (seq === null) return null;
  return { prefix: match[1].toUpperCase(), seq };
}

/**
 * Parse the sequence half of a note ref (`8` or `N8`) into a lookup key,
 * so a note resolves by its number alone.
 *
 * @param token - One trimmed search token.
 * @returns The in-range sequence number, or null when the token is not a
 *   sequence token or names a sequence no note can carry.
 */
function matchNoteSeqToken(token: string): number | null {
  const match = token.match(NOTE_SEQ_TOKEN_PATTERN);
  if (match === null) return null;
  return seqInRange(match[1]);
}

/**
 * Search one project's live notes in a single round trip, structured as
 * task search is: a whole ref resolves exactly, everything else is fuzzy.
 *
 * A ref-shaped query batches the exact ref lookup alongside the fuzzy
 * statements, so the fallback a ref resolving nothing needs costs no second
 * trip; a resolved ref still wins outright and never blends with text hits.
 *
 * Every other query batches two fuzzy tiers: a substring scan over
 * `title`/`summary`/tags (the tier task search serves with `ILIKE`, which
 * FTS stemming cannot: `boarding` finds "Onboarding"), then ranked full
 * text over `search_tsv`, deduped behind the substring hits. With
 * `matchRefFragments` (the notes rail), a query of the ref alphabet also
 * substring-matches the composed ref inside the same scan, so `1` finds
 * `N1`, `N11`, and `N111` as the task list's `taskRef` filter does; MCP
 * search passes false and resolves refs whole only, as task MCP search
 * does.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project to search in.
 * @param trimmed - Non-empty trimmed search text.
 * @param matchRefFragments - Whether ref fragments join the substring tier.
 * @returns The project identifier and the winning hits.
 * @throws ForbiddenError when the caller cannot access the project.
 */
async function searchProjectNotes(
  ctx: AuthContext,
  projectId: string,
  trimmed: string,
  matchRefFragments: boolean,
): Promise<{ projectIdentifier: string; hits: NoteSearchHit[] }> {
  const ref = matchNoteRef(trimmed);
  if (ref !== null) {
    const [gateRows, refRaw, textRaw] = await withUserContextRead(
      ctx.userId,
      (read) => [
        projectAccessGateStmt(read, projectId),
        noteRefSearchStmt(read, projectId, ref.prefix, ref.seq),
        noteSearchStmt(read, projectId, trimmed),
      ],
    );
    const gate = assertProjectGateRows(projectId, gateRows);
    const refHits =
      normalizeExecuteResult<NoteSearchRawRow>(refRaw).map(toSearchHit);
    return {
      projectIdentifier: gate.identifier,
      hits:
        refHits.length > 0
          ? refHits
          : normalizeExecuteResult<NoteSearchRawRow>(textRaw).map(toSearchHit),
    };
  }
  const matchRef = matchRefFragments && REF_FRAGMENT_PATTERN.test(trimmed);
  const [gateRows, substringRaw, textRaw] = await withUserContextRead(
    ctx.userId,
    (read) => [
      projectAccessGateStmt(read, projectId),
      noteSubstringSearchStmt(read, projectId, trimmed, matchRef),
      noteSearchStmt(read, projectId, trimmed),
    ],
  );
  const gate = assertProjectGateRows(projectId, gateRows);
  const substringHits =
    normalizeExecuteResult<NoteSearchRawRow>(substringRaw).map(toSearchHit);
  const textHits =
    normalizeExecuteResult<NoteSearchRawRow>(textRaw).map(toSearchHit);
  const seen = new Set(substringHits.map((hit) => hit.id));
  return {
    projectIdentifier: gate.identifier,
    hits: [...substringHits, ...textHits.filter((hit) => !seen.has(hit.id))],
  };
}

/**
 * Search a project's live notes for the notes rail: exact ref, then
 * title/summary/tag substring (which also matches ref fragments, so `1`
 * finds `N1`, `N11`, and `N111` as the task list's `taskRef` filter does),
 * then ranked full text over `search_tsv` deduped behind the substring
 * hits. User text goes through `websearch_to_tsquery` (plainto fallback),
 * never raw `to_tsquery`; the last term also matches as a sanitized prefix
 * lexeme for type-ahead. Hits are the slim tree projection, never the
 * body.
 *
 * A noteRef (`PREFIX-N<seq>`, case-insensitive) is composed at read time
 * and never enters `search_tsv`, so a ref-shaped query resolves by exact
 * identifier + sequence first. A ref that resolves nothing here (unknown
 * project, trashed or absent note) falls through to the fuzzy tiers, so
 * text that merely looks like a ref still finds a note titled with it.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project to search in.
 * @param query - User search text.
 * @returns Merged hits, substring tier first; empty for a blank query.
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
  const { hits } = await searchProjectNotes(ctx, projectId, trimmed, true);
  return hits;
}

/**
 * Map a raw search row to the slim hit shape.
 *
 * @param row - Raw search row.
 * @returns Slim tree-projection hit.
 */
function toSearchHit(row: NoteSearchRawRow): NoteSearchHit {
  return {
    id: row.id,
    slug: row.slug,
    sequenceNumber: row.sequence_number,
    title: row.title,
    type: row.type as NoteType,
    folder: row.folder,
    feedMode: row.feed_mode as FeedMode,
    summary: row.summary,
    visibility: row.visibility as Visibility,
    agentWritable: row.agent_writable,
    locked: row.locked,
    updatedAt: toDate(row.updated_at),
  };
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
 * Cross-project note search for the ⌘K palette. Bounded by a
 * `current_user_orgs()` subquery (defense-in-depth over RLS); note
 * visibility (private rows confined to their creator, team rows org-wide)
 * is enforced by the `notes` RLS policy under `withUserContextRead`, so
 * private notes never leak cross-tenant. Both arms ship in one read batch
 * — a single stateless HTTP round trip on the Workers head, as the rail
 * search does — instead of an interactive WebSocket transaction.
 *
 * A full noteRef (`PREFIX-N<seq>`, case-insensitive) resolves that note by
 * exact identifier + sequence first. Identifiers are unique per org, so a
 * ref resolves within each of the caller's orgs; a colliding identifier
 * across two of them yields one hit per org, disambiguated by the project
 * crumb. A ref that resolves nothing falls through to the token match, so
 * text that merely looks like a ref still finds a note titled with it.
 *
 * Per-token OR match: `notes.title`, `notes.summary`, each note tag,
 * `projects.title`, `projects.identifier` (case-insensitive substring),
 * plus `notes.sequence_number` for a token that is the sequence half of a
 * ref (`8` or `N8`), so a note resolves by its number alone as a task
 * does. The arms mirror task palette search, with `summary` standing in
 * as the note's second line. Tokens AND-join. Ranked exact → prefix →
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
  const likeLower = escapeLike(lower);
  const rankExpr = sql<number>`CASE
      WHEN LOWER(${notes.title}) = ${lower} THEN 0
      WHEN LOWER(${notes.title}) LIKE ${likeLower + "%"} THEN 1
      WHEN LOWER(${notes.title}) LIKE ${"%" + likeLower + "%"} THEN 2
      ELSE 3
    END`;

  const tokens = trimmed.split(/[\s-]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  const scope = [
    sql`${projects.organizationId} IN (SELECT org_id FROM public.current_user_orgs())`,
    isNull(notes.deletedAt),
  ];
  const tokenClauses = [...scope];
  for (const token of tokens) {
    const pattern = `%${escapeLike(token)}%`;
    const orClauses = [
      ilike(notes.title, pattern),
      ilike(notes.summary, pattern),
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${notes.tags}) AS t WHERE t ILIKE ${pattern})`,
      ilike(projects.title, pattern),
      ilike(projects.identifier, pattern),
    ];
    const seq = matchNoteSeqToken(token);
    if (seq !== null) {
      orClauses.push(eq(notes.sequenceNumber, seq));
    }
    const tokenClause = or(...orClauses);
    if (tokenClause) tokenClauses.push(tokenClause);
  }

  const select = (read: ReadConn, clauses: SQL[]) =>
    read
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

  const ref = matchNoteRef(trimmed);
  if (ref !== null) {
    const [refRows, tokenRows] = await withUserContextRead(
      ctx.userId,
      (read) => [
        select(read, [
          ...scope,
          eq(projects.identifier, ref.prefix),
          eq(notes.sequenceNumber, ref.seq),
        ]),
        select(read, tokenClauses),
      ],
    );
    const rows = refRows.length > 0 ? refRows : tokenRows;
    return rows.map(toCrossProjectHit);
  }

  const [tokenRows] = await withUserContextRead(ctx.userId, (read) => [
    select(read, tokenClauses),
  ]);
  return tokenRows.map(toCrossProjectHit);
}

/**
 * Map a cross-project search row to the palette result shape.
 *
 * @param row - Selected row carrying the note and its project crumb.
 * @returns Palette result with the composed noteRef.
 */
function toCrossProjectHit(row: {
  id: string;
  title: string;
  sequenceNumber: number;
  projectId: string;
  projectIdentifier: string;
  projectTitle: string;
  organizationId: string;
}): CrossProjectNoteSearchResult {
  return {
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
  };
}

/**
 * Collapse backlink rows to one row per note, keeping the most specific
 * link kind (`spec_of` > `reference` > `mention`).
 *
 * @param rows - Backlink rows, one per link.
 * @returns Deduped rows, one per note.
 */
function dedupeBacklinks(
  rows: readonly TaskNoteBacklink[],
): TaskNoteBacklink[] {
  const byNote = new Map<string, TaskNoteBacklink>();
  for (const row of rows) {
    const existing = byNote.get(row.id);
    if (
      !existing ||
      NOTE_TASK_LINK_KIND_RANK[row.kind] >
        NOTE_TASK_LINK_KIND_RANK[existing.kind]
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
 * Count a string in Unicode codepoints, matching Postgres `char_length`
 * and `LEFT`. String `.length` counts UTF-16 code units, so astral
 * characters (emoji, some CJK) would over-count against the char budget
 * and wrongly degrade an in-budget guidance body to a pointer.
 *
 * @param text - Any string.
 * @returns Codepoint count.
 */
function charLen(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/**
 * Apply the §7/§10 bundle budget to exposure-ordered feed rows: admit a
 * strict prefix while both the note cap and the running char budget
 * (per-row codepoint count of `title + summary + body`) hold; the
 * first row failing either bound stops admission and remaining rows
 * degrade to pointers, capped at {@link FEED_POINTER_CAP} with
 * `truncated` flagging any drop. Pure; {@link resolveExposedNotes} and
 * the bundle-batch fold (PYZ-253 decision) both reach it through
 * {@link decodeFeedRows}.
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
    const rowChars =
      charLen(rows[i].title) + charLen(rows[i].summary) + rows[i].bodyChars;
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
    sequenceNumber: row.sequenceNumber,
    noteRef: row.noteRef,
  }));
  return {
    notes: admitted,
    overflow,
    linked: [],
    truncated: pointerEnd < rows.length,
  };
}

/**
 * Coerce a raw feed row to its typed shape (`updated_at` arrives as a
 * string or a Date depending on the driver). The `lengthsOnly` feed
 * variant ships `body_length` in place of the body text, so `bodyChars`
 * takes it verbatim and `body` stays empty; otherwise it is counted off
 * the body that shipped.
 *
 * @param row - Raw driver row.
 * @returns Typed feed row.
 */
function mapNoteFeedRow(row: NoteFeedRawRow): NoteFeedRow {
  const body = row.body ?? "";
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    type: row.type as NoteType,
    folder: row.folder,
    summary: row.summary,
    body,
    bodyChars:
      row.body_length === undefined ? charLen(body) : Number(row.body_length),
    sequenceNumber: row.sequence_number,
    noteRef: composeNoteRef(asIdentifier(row.identifier), row.sequence_number),
    updatedAt: toDate(row.updated_at),
  };
}

/**
 * Fetch bound for one feed read: the effective note cap plus
 * {@link FEED_POINTER_CAP}. Callers pass `feedFetchLimit(budget) + 1` as
 * the SQL LIMIT; the extra sentinel row disambiguates truncation in
 * {@link decodeFeedRows}.
 *
 * @param budget - Optional caller caps.
 * @returns Row bound before the sentinel.
 */
export function feedFetchLimit(budget?: FeedBudget): number {
  return clampFeedBudget(budget).maxNotes + FEED_POINTER_CAP;
}

/**
 * Decode raw feed rows into a budgeted resolution: normalize the driver
 * result, compose note refs, drop the sentinel row past
 * {@link feedFetchLimit}, apply the budget, and flag truncation when the
 * sentinel was present. The single decode for {@link resolveExposedNotes}
 * and the bundle-batch fold, so the sentinel logic is never duplicated.
 *
 * @param rowsRaw - Raw driver result from the feed statement.
 * @param budget - Optional caps; each clamps to [1, its default].
 * @returns Admitted rows, pointer-only overflow, and the truncation flag.
 */
export function decodeFeedRows(
  rowsRaw: unknown,
  budget?: FeedBudget,
): NoteFeedResolution {
  const fetchLimit = feedFetchLimit(budget);
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
 * Resolve the notes an agent may see for one task: the standalone §7
 * exposure entry. The bundle path (PYZ-253) folds {@link notesFeedStmt}
 * into its existing read batch instead and decodes via
 * {@link decodeFeedRows}. A note is exposed iff `visibility = 'team'`
 * AND `feed_mode <> 'none'` AND its feed mode targets the task; the
 * budget then degrades overflow to pointers. The fetch is bounded to
 * note cap + {@link FEED_POINTER_CAP} rows plus one sentinel row, so
 * `truncated` is true only when exposed notes were actually dropped.
 * Zero matches resolve to empty lists, never an error.
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
  const [gateRows, rowsRaw] = await withUserContextRead(ctx.userId, (read) => [
    projectAccessGateStmt(read, projectId),
    notesFeedStmt(read, projectId, task, maxNotes, feedFetchLimit(budget) + 1),
  ]);
  assertProjectGateRows(projectId, gateRows);
  return decodeFeedRows(rowsRaw, budget);
}

/** How a note reaches a bundle: the feed, an explicit link, or budget overflow. */
export type BundleNoteOrigin = "fed" | "linked" | "overflow";

/**
 * One note as a bundle lists it: pointer fields only, never a body.
 * `summary` is empty wherever the bundle itself drops it (overflow
 * pointers render title-only).
 */
export type BundleNoteLink = {
  id: string;
  noteRef: string;
  title: string;
  type: NoteType;
  summary: string;
  origin: BundleNoteOrigin;
};

/**
 * Project a feed row or pointer onto the slim bundle-note link shape.
 *
 * @param note - Feed row or pointer.
 * @param summary - Summary the bundle renders for it, possibly empty.
 * @param origin - How the note reached the bundle.
 * @returns Slim link, never carrying a body.
 */
function toBundleNoteLink(
  note: {
    id: string;
    noteRef: string;
    title: string;
    type: NoteType;
  },
  summary: string,
  origin: BundleNoteOrigin,
): BundleNoteLink {
  return {
    id: note.id,
    noteRef: note.noteRef,
    title: note.title,
    type: note.type,
    summary,
    origin,
  };
}

/**
 * Admitted guidance rows: the ones a deep bundle renders full-body under
 * Project Guidance. Linked and overflow notes stay pointers even when
 * their type is `guidance`.
 *
 * @param feed - Budgeted feed resolution.
 * @returns Admitted guidance rows in emit order.
 */
export function selectGuidanceNotes(feed: NoteFeedResolution): NoteFeedRow[] {
  return feed.notes.filter((row) => row.type === "guidance");
}

/**
 * The same admitted guidance rows as {@link selectGuidanceNotes}, projected
 * to slim links for the web preview. The preview lists what the bundle
 * inlines; it never ships the bodies themselves.
 *
 * @param feed - Budgeted feed resolution.
 * @returns Guidance links in emit order.
 */
export function selectGuidanceLinks(
  feed: NoteFeedResolution,
): BundleNoteLink[] {
  return selectGuidanceNotes(feed).map((row) =>
    toBundleNoteLink(row, row.summary, "fed"),
  );
}

/**
 * Relevant Notes entries in bundle emit order: admitted feed rows
 * (guidance excluded when the caller renders it full-body), then linked
 * pointers, then budget-overflow pointers. Uncapped; callers apply their
 * own width cap. Shared by the markdown emitter and the web bundle
 * preview so the two cannot drift on which notes a bundle carries.
 *
 * @param feed - Budgeted feed resolution.
 * @param opts - `guidanceAsPointers` keeps admitted guidance rows in the list.
 * @returns Ordered pointer entries.
 */
export function selectNotePointers(
  feed: NoteFeedResolution,
  opts: { guidanceAsPointers: boolean },
): BundleNoteLink[] {
  return [
    ...feed.notes
      .filter((row) => opts.guidanceAsPointers || row.type !== "guidance")
      .map((row) => toBundleNoteLink(row, row.summary, "fed")),
    ...feed.linked.map((row) =>
      toBundleNoteLink(row, row.summary ?? "", "linked"),
    ),
    ...feed.overflow.map((row) => toBundleNoteLink(row, "", "overflow")),
  ];
}

/** Task row the note feed matches against, plus the feed's cache validator. */
type TaskFeedTargetRow = {
  id: string;
  projectId: string;
  category: string | null;
  tags: string[] | null;
  updatedAt: Date;
};

/**
 * The task's feed-target columns. `category` and `tags` are the task side
 * of the feed match and appear in no other task projection this surface
 * reads. `updatedAt` is a validator input no note or link timestamp can
 * observe: retagging a task changes which notes feed it without touching
 * any note row.
 *
 * @param read - Read statement-building handle.
 * @param taskId - Task UUID.
 * @returns Lazy single-row statement.
 */
function taskFeedTargetStmt(read: ReadConn, taskId: string) {
  return read
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      category: tasks.category,
      tags: tasks.tags,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
}

/** A task's note context: its linked notes plus the bundle's note feed. */
export type TaskNoteContext = {
  backlinks: TaskNoteBacklink[];
  feed: NoteFeedResolution;
  taskUpdatedAt: Date;
};

/**
 * Resolve everything the task detail surface needs about notes: the
 * linked-note backlinks the Linked Notes section renders, and the same
 * feed resolution the context bundle carries, with backlinks folded in as
 * `linked` pointers exactly as the bundle path does.
 *
 * `deep` mirrors the bundle depth. Deep bundles (agent, planning, review)
 * charge guidance body length against the feed char budget, so body length
 * decides which notes are admitted rather than overflowed; slim bundles
 * select no body column at all. This surface renders links only, so it
 * takes the `lengthsOnly` variant: the budget arithmetic gets its char
 * counts and the body text never leaves Postgres.
 *
 * One batch. The feed statement reads the task row in a CTE rather than
 * binding a category and tags a prior read would have to supply, so it
 * rides the same round trip as the backlinks. The task row doubles as the
 * access gate, so no separate gate statement runs: RLS hides rows the
 * caller cannot reach, making an empty result the 404 signal, and it hides
 * them from the feed's CTE on the same terms.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @param deep - Whether the target bundle charges guidance bodies.
 * @returns Backlinks, the folded feed resolution, and the task's validator.
 * @throws ForbiddenError when the caller cannot access the task.
 */
export async function getTaskNoteContext(
  ctx: AuthContext,
  taskId: string,
  deep: boolean,
): Promise<TaskNoteContext> {
  assertValidTaskId(taskId);
  const bodies: NoteFeedBodyBound | undefined = deep
    ? {
        rankCap: FEED_NOTE_CAP,
        charBound: FEED_CHAR_BUDGET + 1,
        budget: FEED_CHAR_BUDGET,
        lengthsOnly: true,
      }
    : undefined;
  const [taskRows, linkRows, pointerRows, feedRaw] = await withUserContextRead(
    ctx.userId,
    (read) => [
      taskFeedTargetStmt(read, taskId),
      taskNoteBacklinksStmt(read, taskId),
      taskBacklinkPointersStmt(read, taskId),
      notesFeedForTaskStmt(
        read,
        taskId,
        FEED_NOTE_CAP,
        feedFetchLimit() + 1,
        bodies,
      ),
    ],
  );
  const task = firstRowOrForbidden(
    "task",
    taskId,
    taskRows as TaskFeedTargetRow[],
  );

  return {
    backlinks: dedupeBacklinks(linkRows),
    feed: foldBacklinkPointers(decodeFeedRows(feedRaw), pointerRows),
    taskUpdatedAt: task.updatedAt,
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
  assertCreateInputWithinCaps(input);
  const visibility = input.visibility ?? "private";

  const created = await withUserContext(ctx.userId, async (tx) => {
    const access = await assertProjectAccessTx(tx, input.projectId);
    assertProjectWritable(access.project.status, access.project.identifier);
    await acquireProjectLock(tx, input.projectId);
    return createNoteInTx(tx, ctx, input, access.project.identifier);
  });

  emitNoteEvent(
    created.projectId,
    created.id,
    visibility,
    created.updatedAt,
    created.version,
  );
  return created;
}

/**
 * Validate one create input against the field caps, shared by
 * {@link createNote} and {@link createNotesBatch}.
 *
 * @param input - Create fields; `projectId` is validated by the caller.
 * @throws NoteValidationError on any cap violation.
 */
function assertCreateInputWithinCaps(
  input: Omit<CreateNoteInput, "projectId">,
): void {
  assertTitleWithinCap(input.title);
  assertBodyWithinCap(input.body ?? "");
  assertMetadataWithinCaps(input);
}

/**
 * Insert one note inside an open write transaction: slug allocation, the
 * insert, body-driven link derivation, the v1 revision snapshot, and the
 * note-keyed activity event. The caller must have gated project
 * access, asserted writability, and taken the project advisory lock.
 * Shared by {@link createNote} and {@link createNotesBatch}.
 *
 * @param tx - Active RLS transaction handle.
 * @param ctx - Resolved auth context.
 * @param input - Validated note fields.
 * @param projectIdentifier - Owning project identifier for link
 *   derivation and the composed summary.
 * @returns Slim summary of the created note.
 */
async function createNoteInTx(
  tx: Tx,
  ctx: AuthContext,
  input: CreateNoteInput,
  projectIdentifier: string,
): Promise<NoteSummary> {
  const body = input.body ?? "";
  const folder = normalizeFolder(input.folder ?? "");
  const visibility = input.visibility ?? "private";
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
      ...(visibility === "team" ? { sharedSince: sql`now()` } : {}),
      summary: input.summary ?? "",
      tags: input.tags ?? [],
      category: input.category ?? null,
      feedMode: input.feedMode ?? "none",
      feedCategories: canonicalizeFeedLabels(input.feedCategories ?? []),
      feedTags: canonicalizeFeedLabels(input.feedTags ?? []),
      agentWritable: true,
      locked: false,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    })
    .returning(noteSummaryColumns);

  await replaceFeedTaskLinks(
    tx,
    note.id,
    input.projectId,
    input.feedTaskIds ?? [],
    true,
  );

  if (body !== "") {
    await replaceDerivedLinks(
      tx,
      note.id,
      input.projectId,
      projectIdentifier,
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
  await insertActivityEvents(tx, ctx.actor, [
    {
      projectId: input.projectId,
      taskId: null,
      noteId: note.id,
      type: "note_created",
      targetRef: slug,
      summary: `created note "${summaryTitle(input.title)}"`,
    },
  ]);
  return { ...note, projectIdentifier };
}

/** One {@link createNotesBatch} item; projectId and visibility come from the call. */
export type CreateNoteBatchItem = Omit<
  CreateNoteInput,
  "projectId" | "visibility"
>;

/** Result of {@link createNotesBatch}: inserted rows plus dedupe hits. */
export type NotesBatchResult = {
  created: NoteSummary[];
  deduped: NoteSummary[];
};

/** Item cap per {@link createNotesBatch} call. */
export const MAX_NOTE_BATCH = 10;

/**
 * Compose the batch-dedupe key for a (folder, title) pair. NUL separates
 * the parts because it cannot appear in either (folder segments are
 * trimmed path text, titles are byte-capped user text), so distinct pairs
 * never collide.
 *
 * @param folder - Normalized folder path.
 * @param title - Note title.
 * @returns Collision-free composite key.
 */
function dedupeKey(folder: string, title: string): string {
  return `${folder}\u0000${title}`;
}

/**
 * Create 1-{@link MAX_NOTE_BATCH} notes in one transaction under the
 * project advisory lock. Idempotent by exact (normalized folder, title)
 * among live notes: with `onDuplicate='skip'` (the default) colliding
 * items return under `deduped` with the existing rows, so a retried
 * batch never duplicates a note set; `onDuplicate='error'` rejects the
 * whole batch instead. Intra-batch (folder, title) repeats dedupe to the
 * first occurrence. Teammates' private notes are invisible to the dedupe
 * probe (RLS); a title collision with one only affects slug suffixing.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param items - Note fields per item.
 * @param opts - `visibility` applied to every item (the MCP handler
 *   passes `team` per the PYZ-264 creator-dependent default) and the
 *   duplicate policy.
 * @returns Created and deduped summaries, batch order preserved.
 * @throws BatchInputError when the item count is out of range.
 * @throws DuplicateNoteTitleError with `onDuplicate='error'` on any
 *   (folder, title) collision.
 * @throws ForbiddenError when the caller cannot access the project.
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteValidationError on any field cap violation.
 */
export async function createNotesBatch(
  ctx: AuthContext,
  projectId: string,
  items: CreateNoteBatchItem[],
  opts: { visibility: Visibility; onDuplicate?: "skip" | "error" },
): Promise<NotesBatchResult> {
  assertValidProjectId(projectId);
  if (items.length === 0 || items.length > MAX_NOTE_BATCH) {
    throw new BatchInputError(
      `notes must contain 1-${MAX_NOTE_BATCH} items, got ${items.length}`,
    );
  }
  const prepared = items.map((item) => {
    assertCreateInputWithinCaps(item);
    return { ...item, folder: normalizeFolder(item.folder ?? "") };
  });
  const onDuplicate = opts.onDuplicate ?? "skip";

  const result = await withUserContext(ctx.userId, async (tx) => {
    const access = await assertProjectAccessTx(tx, projectId);
    assertProjectWritable(access.project.status, access.project.identifier);
    await acquireProjectLock(tx, projectId);

    const existing = await tx
      .select(noteSummaryColumns)
      .from(notes)
      .where(
        and(
          eq(notes.projectId, projectId),
          isNull(notes.deletedAt),
          inArray(
            notes.title,
            prepared.map((item) => item.title),
          ),
        ),
      );
    const byKey = new Map<string, NoteSummary>();
    for (const row of existing) {
      byKey.set(dedupeKey(row.folder, row.title), {
        ...row,
        projectIdentifier: access.project.identifier,
      });
    }

    if (onDuplicate === "error") {
      const collisions = prepared.filter((item) =>
        byKey.has(dedupeKey(item.folder, item.title)),
      );
      if (collisions.length > 0) {
        throw new DuplicateNoteTitleError(collisions.map((c) => c.title));
      }
    }

    const created: NoteSummary[] = [];
    const deduped: NoteSummary[] = [];
    for (const item of prepared) {
      const key = dedupeKey(item.folder, item.title);
      const hit = byKey.get(key);
      if (hit) {
        deduped.push(hit);
        continue;
      }
      const summary = await createNoteInTx(
        tx,
        ctx,
        { ...item, projectId, visibility: opts.visibility },
        access.project.identifier,
      );
      byKey.set(key, summary);
      created.push(summary);
    }
    return { created, deduped };
  });

  for (const note of result.created) {
    emitNoteEvent(
      note.projectId,
      note.id,
      opts.visibility,
      note.updatedAt,
      note.version,
    );
  }
  return result;
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
 * @param opts - `restoredFromVersion` marks the write as a revision
 *   restore: the emitted event's summary and metadata name the source
 *   version, and the pre-restore state is checkpointed unconditionally.
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
  opts?: { restoredFromVersion?: number },
): Promise<
  NoteSummary & {
    links?: NoteLinksRefresh;
    revisionCheckpoint?: NoteRevisionCheckpoint;
  }
> {
  return updateNoteCore(
    ctx,
    noteId,
    patch,
    ifUpdatedAt,
    undefined,
    opts?.restoredFromVersion,
  );
}

/** Fields a {@link NoteEditOp} may target; governance fields (`visibility`, `locked`, `agentWritable`) are excluded by design. */
export type NoteEditField =
  | "body"
  | "title"
  | "summary"
  | "folder"
  | "type"
  | "category"
  | "tags"
  | "feedMode"
  | "feedCategories"
  | "feedTags"
  | "feedTaskIds";

/** A single operation-based note edit; text ops target `body` only. */
export type NoteEditOp = {
  op: "str_replace" | "append" | "set";
  field: NoteEditField;
  oldStr?: string;
  newStr?: string;
  text?: string;
  value?: unknown;
};

/** Op cap per {@link applyNoteEditOps} call, mirroring the task editor. */
export const MAX_NOTE_EDIT_OPS = 20;

/** Note type values accepted by an op-based `set`. */
const NOTE_TYPE_VALUES = ["reference", "guidance", "knowledge"] as const;

/** Feed mode values accepted by an op-based `set` (PYZ-264 §14.3 enum). */
const FEED_MODE_VALUES = [
  "none",
  "all",
  "categories",
  "tags",
  "tasks",
] as const;

/**
 * Narrow an op value to a string array.
 *
 * @param value - Candidate value.
 * @returns Whether every element is a string.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Validate ordered note-edit ops and split them into the scalar patch and
 * the body text-op sequence. Scalar `set` repeats last-win; body ops keep
 * their relative order for the in-transaction fold.
 *
 * @param ops - Ordered edit ops.
 * @returns The scalar patch and the body ops.
 * @throws InvalidEditOpError on any structurally incoherent op.
 */
function prepareNoteEditOps(ops: NoteEditOp[]): {
  patch: NotePatch;
  bodyOps: TextOp[];
} {
  if (ops.length === 0 || ops.length > MAX_NOTE_EDIT_OPS) {
    throw new InvalidEditOpError(
      0,
      `operations must contain 1-${MAX_NOTE_EDIT_OPS} ops, got ${ops.length}`,
    );
  }
  const patch: NotePatch = {};
  const bodyOps: TextOp[] = [];
  ops.forEach((op, index) => {
    const bad = (reason: string): never => {
      throw new InvalidEditOpError(index, reason);
    };
    if (op.field === "body") {
      if (op.op === "str_replace") {
        if (typeof op.oldStr !== "string" || op.oldStr.length === 0) {
          bad("str_replace requires a non-empty oldStr");
        }
        if (typeof op.newStr !== "string") bad("str_replace requires newStr");
        bodyOps.push({
          t: "str_replace",
          field: "body",
          oldStr: op.oldStr as string,
          newStr: op.newStr as string,
        });
        return;
      }
      if (op.op === "append") {
        if (typeof op.text !== "string") bad("append requires text");
        bodyOps.push({ t: "append", field: "body", text: op.text as string });
        return;
      }
      const value = op.text !== undefined ? op.text : op.value;
      if (typeof value !== "string") {
        bad("set body requires string text (or value)");
      }
      bodyOps.push({ t: "set", field: "body", value: value as string });
      return;
    }
    if (op.op !== "set") {
      bad(`${op.op} targets body only; use set for ${op.field}`);
    }
    const value = "value" in op && op.value !== undefined ? op.value : op.text;
    switch (op.field) {
      case "title":
        if (typeof value !== "string" || value.trim() === "") {
          bad("set title requires non-empty string text");
        }
        patch.title = value as string;
        return;
      case "summary":
        if (typeof value !== "string") bad("set summary requires string text");
        patch.summary = value as string;
        return;
      case "folder":
        if (typeof value !== "string") bad("set folder requires a string path");
        patch.folder = value as string;
        return;
      case "type":
        if (!(NOTE_TYPE_VALUES as readonly unknown[]).includes(value)) {
          bad(`set type requires one of ${NOTE_TYPE_VALUES.join(", ")}`);
        }
        patch.type = value as NoteType;
        return;
      case "category":
        if (value !== null && typeof value !== "string") {
          bad("set category requires a string or null value");
        }
        patch.category = value as string | null;
        return;
      case "tags":
      case "feedCategories":
      case "feedTags":
      case "feedTaskIds":
        if (!isStringArray(value)) {
          bad(`set ${op.field} requires an array of strings`);
        }
        patch[op.field] = value as string[];
        return;
      case "feedMode":
        if (!(FEED_MODE_VALUES as readonly unknown[]).includes(value)) {
          bad(`set feedMode requires one of ${FEED_MODE_VALUES.join(", ")}`);
        }
        patch.feedMode = value as FeedMode;
        return;
      default: {
        const field = op.field as string;
        if (field === "visibility") {
          bad(
            "agents never set visibility; a private note becomes team-visible only through action='request_share' and human approval",
          );
        }
        if (field === "locked" || field === "agentWritable") {
          bad(
            `${field} is a human governance control in the note's ribbon; ask the user to change it`,
          );
        }
        bad(`field '${field}' is not editable via ops`);
      }
    }
  });
  return { patch, bodyOps };
}

/**
 * Apply 1-{@link MAX_NOTE_EDIT_OPS} ordered ops to one note atomically,
 * with the task editor's semantics: body `str_replace` requires exactly
 * one match (the error names the occurrence count), `append` joins with a
 * blank line, scalar `set` replaces the field, and the whole call is a
 * compare-and-swap when `ifUpdatedAt` is passed. Body ops fold inside the
 * write transaction's locked read, so the edit is race-free even without
 * a precondition.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @param ops - Ordered edit ops.
 * @param ifUpdatedAt - Optional CAS precondition from a prior read.
 * @returns Slim summary; a body change also carries the re-derived links.
 * @throws InvalidEditOpError on any structurally incoherent op.
 * @throws NoteStaleWriteError when `ifUpdatedAt` mismatches.
 * @throws NoteLockedError when the note is locked.
 * @throws ForbiddenError on inaccessible or trashed notes.
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteValidationError on cap violations.
 */
export async function applyNoteEditOps(
  ctx: AuthContext,
  noteId: string,
  ops: NoteEditOp[],
  ifUpdatedAt?: string,
): Promise<NoteSummary & { links?: NoteLinksRefresh }> {
  const { patch, bodyOps } = prepareNoteEditOps(ops);
  return updateNoteCore(ctx, noteId, patch, ifUpdatedAt, bodyOps);
}

/**
 * Shared write core behind {@link updateNote} (whole-field patch) and
 * {@link applyNoteEditOps} (op-based edit). `bodyOps`, when present, fold
 * into the new body inside the transaction, reading the current body
 * under the same `FOR UPDATE` lock that serves the access gate and CAS
 * baseline.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @param patch - Scalar patch fields.
 * @param ifUpdatedAt - Optional CAS precondition from a prior read.
 * @param bodyOps - Ordered body text ops to fold in-transaction.
 * @param restoredFromVersion - Source revision version when the write is a
 *   restore; names the source version in the emitted event and forces the
 *   pre-image checkpoint.
 * @returns Slim summary; a body change also carries the re-derived links.
 */
async function updateNoteCore(
  ctx: AuthContext,
  noteId: string,
  patch: NotePatch,
  ifUpdatedAt?: string,
  bodyOps?: TextOp[],
  restoredFromVersion?: number,
): Promise<
  NoteSummary & {
    links?: NoteLinksRefresh;
    revisionCheckpoint?: NoteRevisionCheckpoint;
  }
> {
  assertValidNoteId(noteId);
  const applied: NotePatch = {};
  for (const field of PATCHABLE_NOTE_FIELDS) {
    if (patch[field] !== undefined) {
      (applied as Record<string, unknown>)[field] = patch[field];
    }
  }
  for (const field of ["feedCategories", "feedTags"] as const) {
    const values = applied[field];
    if (values !== undefined) applied[field] = canonicalizeFeedLabels(values);
  }
  if (applied.title !== undefined) assertTitleWithinCap(applied.title);
  if (applied.body !== undefined) assertBodyWithinCap(applied.body);
  assertMetadataWithinCaps(applied);
  // feedTaskIds now lives in the note_feed_tasks join, not the notes column,
  // so pull it out of the column patch and drive the join write manually.
  const nextFeedTaskIds = applied.feedTaskIds;
  delete applied.feedTaskIds;
  if (applied.folder !== undefined) {
    applied.folder = normalizeFolder(applied.folder);
  }
  const ifUpdatedAtMs =
    ifUpdatedAt === undefined ? undefined : parseIfUpdatedAt(ifUpdatedAt);

  const hasBodyOps = bodyOps !== undefined && bodyOps.length > 0;
  const result = await withUserContext(ctx.userId, async (tx) => {
    const needsBody = applied.body !== undefined || hasBodyOps;
    const [current] = await tx
      .select({
        id: notes.id,
        projectId: notes.projectId,
        slug: notes.slug,
        sequenceNumber: notes.sequenceNumber,
        title: notes.title,
        folder: notes.folder,
        tags: notes.tags,
        type: notes.type,
        category: notes.category,
        summary: notes.summary,
        feedMode: notes.feedMode,
        feedCategories: notes.feedCategories,
        feedTags: notes.feedTags,
        agentWritable: notes.agentWritable,
        locked: notes.locked,
        visibility: notes.visibility,
        version: notes.version,
        updatedAt: notes.updatedAt,
        embeddingStatus: notes.embeddingStatus,
        deletedAt: notes.deletedAt,
        createdBy: notes.createdBy,
        updatedBy: notes.updatedBy,
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
    assertAgentWritable(ctx, current.agentWritable);
    if (
      ifUpdatedAtMs !== undefined &&
      ifUpdatedAtMs !== current.updatedAt.getTime()
    ) {
      throw new NoteStaleWriteError(current.updatedAt, current.version);
    }
    if (hasBodyOps && bodyOps) {
      let running: string | null = current.body;
      for (const op of bodyOps) running = foldTextOp(running, op);
      const newBody = running ?? "";
      assertBodyWithinCap(newBody);
      applied.body = newBody;
    }
    // Feed-task set writes to the note_feed_tasks join, not the notes
    // column, so its change verdict cannot ride the notes UPDATE's
    // change-detection. Replace the rows here (filtered to same-project live
    // tasks) and fold the boolean into the no-op guards and clock bumps
    // below, mirroring replaceDerivedLinks.
    const feedTaskIdsChanged =
      nextFeedTaskIds !== undefined
        ? await replaceFeedTaskLinks(
            tx,
            noteId,
            current.projectId,
            nextFeedTaskIds,
            false,
          )
        : false;

    const currentSummary = gateSummary(current);
    if (Object.keys(applied).length === 0 && !feedTaskIdsChanged) {
      return {
        summary: currentSummary,
        wasNoOp: true,
        visibility: current.visibility,
        links: undefined,
        revisionCheckpoint: undefined,
        metaChanged: false,
        flippedToPrivate: false,
      };
    }

    const bodyChanged = needsBody && applied.body !== current.body;
    const changedFields = dropUnchangedFields(applied, current, bodyChanged);
    if (changedFields.length === 0 && !feedTaskIdsChanged) {
      return {
        summary: currentSummary,
        wasNoOp: true,
        visibility: current.visibility,
        links: undefined,
        revisionCheckpoint: undefined,
        metaChanged: false,
        flippedToPrivate: false,
      };
    }
    if (feedTaskIdsChanged) changedFields.push("feedTaskIds");
    const newVersion = bodyChanged ? current.version + 1 : current.version;
    const changes: Record<string, unknown> = {
      ...applied,
      updatedBy: ctx.userId,
      updatedAt: dbClockStamp(),
    };
    if (bodyChanged) {
      changes.version = newVersion;
      if (current.embeddingStatus !== "none") changes.embeddingStatus = "stale";
    }
    if (applied.visibility === "team" && current.visibility !== "team") {
      changes.shareRequestedBy = null;
      changes.sharedSince = sql`now()`;
    }
    if (applied.visibility === "private" && current.visibility !== "private") {
      changes.sharedSince = null;
    }

    const nextVisibility = applied.visibility ?? current.visibility;

    // Derivation runs BEFORE the notes UPDATE (it only reads other rows and
    // excludes self) so its changed-set verdict can fold into the same
    // UPDATE: metadata field changes and link-set changes share one
    // meta_updated_at bump; no second round trip.
    const derivedLinksChanged = bodyChanged
      ? await replaceDerivedLinks(
          tx,
          noteId,
          current.projectId,
          current.projectIdentifier,
          applied.body ?? "",
          false,
        )
      : false;
    // Metadata clock rule: every change except a pure body edit moves
    // `meta_updated_at`. The graph and notes-tree validators read it, so
    // body autosaves stay 304-cheap while any rendered field (or a derived
    // link set) revalidates.
    const metaChanged =
      derivedLinksChanged ||
      feedTaskIdsChanged ||
      changedFields.some((field) => field !== "body");
    if (metaChanged) {
      changes.metaUpdatedAt = dbClockStamp();
    }
    // A team-to-private flip hides the row from other members under RLS,
    // so their note-clock MAX can no longer observe the bump above.
    // Moving the project content clock (visible to every member) makes
    // their graph and context validators register the disappearance. The
    // refetch that consults those validators is triggered by the
    // post-commit project event below; the note event itself rides
    // `note:<id>` after the flip, which other members never subscribed
    // to.
    const flippedToPrivate =
      applied.visibility === "private" && current.visibility === "team";
    if (flippedToPrivate) {
      await tx
        .update(projects)
        .set({
          updatedAt: dbClockStamp(),
        })
        .where(eq(projects.id, current.projectId));
    }

    const [summary] = await tx
      .update(notes)
      .set(changes)
      .where(eq(notes.id, noteId))
      .returning(noteSummaryColumns);

    let links: NoteLinksRefresh | undefined;
    let revisionCheckpoint: NoteRevisionCheckpoint | undefined;
    if (bodyChanged) {
      const [newestRevision] = await tx
        .select({
          version: noteRevisions.version,
          createdAt: noteRevisions.createdAt,
        })
        .from(noteRevisions)
        .where(eq(noteRevisions.noteId, noteId))
        .orderBy(desc(noteRevisions.version))
        .limit(1);
      const preImageUnsnapshotted =
        newestRevision === undefined ||
        newestRevision.version < current.version;
      const mustCheckpoint =
        newestRevision === undefined ||
        restoredFromVersion !== undefined ||
        ctx.actor.source === "mcp" ||
        current.updatedBy !== ctx.userId ||
        Date.now() - newestRevision.createdAt.getTime() >=
          NOTE_REVISION_CHECKPOINT_MS;
      if (preImageUnsnapshotted && mustCheckpoint) {
        await insertRevisionWithPrune(
          tx,
          noteId,
          current.version,
          current.title,
          current.body,
          current.updatedBy === ctx.userId ? ctx.userId : null,
          current.updatedAt,
        );
        revisionCheckpoint = {
          version: current.version,
          title: current.title,
          createdAt: current.updatedAt,
        };
      }
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
          sequenceNumber: notes.sequenceNumber,
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
    await insertActivityEvents(tx, ctx.actor, [
      {
        projectId: current.projectId,
        taskId: null,
        noteId: current.id,
        type: "note_updated",
        targetRef: summary.slug,
        summary:
          restoredFromVersion !== undefined
            ? `restored note "${summaryTitle(summary.title)}" to v${restoredFromVersion}`
            : `updated note "${summaryTitle(summary.title)}"`,
        metadata: {
          fields: changedFields,
          version: newVersion,
          ...(restoredFromVersion !== undefined ? { restoredFromVersion } : {}),
        },
      },
    ]);
    return {
      summary: { ...summary, projectIdentifier: current.projectIdentifier },
      wasNoOp: false,
      visibility: nextVisibility,
      links,
      revisionCheckpoint,
      metaChanged,
      flippedToPrivate,
    };
  });

  if (!result.wasNoOp) {
    emitNoteEvent(
      result.summary.projectId,
      result.summary.id,
      result.visibility,
      result.summary.updatedAt,
      result.summary.version,
      result.revisionCheckpoint !== undefined,
      result.metaChanged,
    );
    if (result.flippedToPrivate) {
      emitProjectEvent(result.summary.projectId);
      purgeNoteChannel(result.summary.id, ctx.userId);
    }
  }
  return {
    ...result.summary,
    ...(result.links !== undefined ? { links: result.links } : {}),
    ...(result.revisionCheckpoint !== undefined
      ? { revisionCheckpoint: result.revisionCheckpoint }
      : {}),
  };
}

/**
 * Move one note into a folder. The gate read locks the notes row
 * (`FOR UPDATE OF notes`) so the CAS compare and the write share one
 * locked snapshot.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @param folder - Destination folder path (`""` = root).
 * @param ifUpdatedAt - Optional CAS precondition from a prior read.
 * @returns Slim summary of the moved note.
 * @throws ForbiddenError on inaccessible or trashed notes.
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteStaleWriteError when `ifUpdatedAt` mismatches.
 * @throws NoteValidationError when the folder path exceeds the cap or
 *   `ifUpdatedAt` is malformed.
 */
export async function moveNote(
  ctx: AuthContext,
  noteId: string,
  folder: string,
  ifUpdatedAt?: string,
): Promise<NoteSummary> {
  assertValidNoteId(noteId);
  const dest = normalizeFolder(folder);
  const ifUpdatedAtMs =
    ifUpdatedAt === undefined ? undefined : parseIfUpdatedAt(ifUpdatedAt);

  const result = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertNoteAccessTx(tx, noteId, { forUpdate: true });
    assertNoteLive(gate);
    assertProjectWritable(gate.projectStatus, gate.projectIdentifier);
    if (gate.locked) throw new NoteLockedError();
    assertAgentWritable(ctx, gate.agentWritable);
    if (
      ifUpdatedAtMs !== undefined &&
      ifUpdatedAtMs !== gate.updatedAt.getTime()
    ) {
      throw new NoteStaleWriteError(gate.updatedAt, gate.version);
    }
    if (gate.folder === dest) {
      return {
        summary: gateSummary(gate),
        wasNoOp: true,
        visibility: gate.visibility,
      };
    }
    const [summary] = await tx
      .update(notes)
      .set({
        folder: dest,
        updatedBy: ctx.userId,
        updatedAt: dbClockStamp(),
        metaUpdatedAt: dbClockStamp(),
      })
      .where(eq(notes.id, noteId))
      .returning(noteSummaryColumns);
    await insertActivityEvents(tx, ctx.actor, [
      {
        projectId: gate.projectId,
        taskId: null,
        noteId: gate.id,
        type: "note_moved",
        targetRef: summary.slug,
        summary: `moved note "${summaryTitle(summary.title)}"`,
        metadata: { from: gate.folder, to: dest },
      },
    ]);
    return {
      summary: { ...summary, projectIdentifier: gate.projectIdentifier },
      wasNoOp: false,
      visibility: gate.visibility,
    };
  });

  if (!result.wasNoOp) {
    emitNoteEvent(
      result.summary.projectId,
      result.summary.id,
      result.visibility,
      result.summary.updatedAt,
      result.summary.version,
      undefined,
      true,
    );
  }
  return result.summary;
}

/**
 * Re-parent a folder and its whole subtree: one UPDATE rewrites the
 * `folder` prefix on every live descendant note, and explicit
 * `note_folders` markers under the prefix are rewritten as
 * delete-then-insert (deleting first keeps a rewritten path that lands
 * back under the source prefix out of the delete filter; fresh rows keep
 * the folders-list validator moving, and `onConflictDoNothing` merges a
 * racing collision instead of erroring). An empty explicit folder moves
 * through this same path with zero notes, so the guards pass trivially
 * and no activity event fires. Moving a folder into itself or a
 * descendant is rejected. Passing `newLeaf` replaces the folder's own
 * name at the destination, so a rename is a move to the same parent with
 * a new leaf. The UPDATE runs under the caller's RLS scope, so
 * teammates' private notes in the subtree are untouched and keep their
 * old paths; a definer-privileged bulk write would let members rewrite
 * paths of notes they cannot see. Each moved note records its own
 * note-keyed `note_moved` event (read-time gating scopes who sees it,
 * matching {@link moveNote}); the project dispatch fires only when a
 * team-visible note actually moved, and a `note-folders` dispatch fires
 * when explicit marker rows were rewritten.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param src - Folder path being moved (must be non-root).
 * @param destParent - New parent path (`""` = root).
 * @param newLeaf - Replacement folder name; defaults to `src`'s leaf.
 * @returns The destination path, how many notes moved, and how many
 *   explicit marker rows were rewritten.
 * @throws ForbiddenError when the caller cannot access the project.
 * @throws ProjectArchivedError when the project is archived.
 * @throws FolderCycleError when `destParent` is `src` or a descendant.
 * @throws NoteValidationError when a path fails normalization, `newLeaf`
 *   normalizes to empty, or the move would push any resulting path past
 *   the folder cap.
 * @throws NoteLockedError when any note in the subtree is locked.
 * @throws NoteAgentReadOnlyError when an MCP actor moves a subtree
 *   containing an agent-read-only note.
 */
export async function moveFolder(
  ctx: AuthContext,
  projectId: string,
  src: string,
  destParent: string,
  newLeaf?: string,
): Promise<{ dest: string; movedCount: number; explicitMoved: number }> {
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
  if ([...dest].length > NOTE_FOLDER_MAX_CHARS) {
    throw new NoteValidationError(
      "folder",
      `folder exceeds ${NOTE_FOLDER_MAX_CHARS} characters`,
    );
  }
  const growth = [...dest].length - [...srcPath].length;

  const moved = await withUserContext(ctx.userId, async (tx) => {
    const access = await assertProjectAccessTx(tx, projectId);
    assertProjectWritable(access.project.status, access.project.identifier);
    if (dest === srcPath) {
      return {
        movedCount: 0,
        teamMoved: false,
        explicitMoved: 0,
        movedNotes: [],
      };
    }
    await acquireProjectLock(tx, projectId);
    const subtreeFilter = and(
      eq(notes.projectId, projectId),
      isNull(notes.deletedAt),
      folderSubtreePredicate(notes.folder, srcPath),
    );
    const explicitSubtreeFilter = and(
      eq(noteFolders.projectId, projectId),
      folderSubtreePredicate(noteFolders.path, srcPath),
    );
    const [guard] = await tx
      .select({
        lockedCount: sql<number>`count(*) filter (where ${notes.locked})`,
        readOnlyCount: sql<number>`count(*) filter (where not ${notes.agentWritable})`,
        longest: sql<number | null>`max(char_length(${notes.folder}))`,
        explicitLongest: sql<
          number | null
        >`(select max(char_length(${noteFolders.path})) from ${noteFolders} where ${explicitSubtreeFilter})`,
      })
      .from(notes)
      .where(subtreeFilter);
    if (Number(guard?.lockedCount ?? 0) > 0) throw new NoteLockedError();
    if (ctx.actor.source === "mcp" && Number(guard?.readOnlyCount ?? 0) > 0) {
      throw new NoteAgentReadOnlyError();
    }
    const longest = Math.max(guard?.longest ?? 0, guard?.explicitLongest ?? 0);
    if (growth > 0 && longest + growth > NOTE_FOLDER_MAX_CHARS) {
      throw new NoteValidationError(
        "folder",
        `move would push a descendant past ${NOTE_FOLDER_MAX_CHARS} characters`,
      );
    }
    const rows = await tx
      .update(notes)
      .set({
        folder: sql`${dest} || substr(${notes.folder}, char_length(${srcPath}::text) + 1)`,
        updatedBy: ctx.userId,
        updatedAt: dbClockStamp(),
        metaUpdatedAt: dbClockStamp(),
      })
      .where(subtreeFilter)
      .returning({
        id: notes.id,
        slug: notes.slug,
        title: notes.title,
        folder: notes.folder,
        visibility: notes.visibility,
        updatedAt: notes.updatedAt,
        version: notes.version,
      });
    const explicitRows = await tx
      .delete(noteFolders)
      .where(explicitSubtreeFilter)
      .returning({ path: noteFolders.path });
    if (explicitRows.length > 0) {
      await tx
        .insert(noteFolders)
        .values(
          explicitRows.map((row) => ({
            projectId,
            path: dest + row.path.slice(srcPath.length),
            createdBy: ctx.userId,
          })),
        )
        .onConflictDoNothing();
    }
    const teamMoved = rows.some((row) => row.visibility === "team");
    if (rows.length > 0) {
      await insertActivityEvents(
        tx,
        ctx.actor,
        rows.map((row) => ({
          projectId,
          taskId: null,
          noteId: row.id,
          type: "note_moved" as const,
          targetRef: row.slug,
          summary: `moved note "${summaryTitle(row.title)}"`,
          metadata: {
            from: srcPath + row.folder.slice(dest.length),
            to: row.folder,
          },
        })),
      );
    }
    return {
      movedCount: rows.length,
      teamMoved,
      explicitMoved: explicitRows.length,
      movedNotes: rows.map((row) => ({
        id: row.id,
        visibility: row.visibility,
        updatedAt: row.updatedAt,
        version: row.version,
      })),
    };
  });

  if (moved.teamMoved) emitProjectEvent(projectId);
  // Folder paths on note rows changed too, so viewers must revalidate the
  // tree list, not just the explicit-folder set; the client's note-folders
  // handler invalidates both.
  if (moved.movedCount > 0 || moved.explicitMoved > 0) {
    emitNoteFoldersEvent(projectId);
  }
  // Per-note events so open remote editors refresh their cached detail
  // (folder path + CAS token) — the note-folders event above only reaches
  // the tree and folder queries.
  emitNoteEventsBatch(projectId, moved.movedNotes);
  return {
    dest,
    movedCount: moved.movedCount,
    explicitMoved: moved.explicitMoved,
  };
}

/**
 * Persist an explicitly created empty folder as a `note_folders` marker
 * row. Idempotent: a duplicate create upserts into the existing row via
 * `onConflictDoNothing` on the `(project_id, path)` unique index. No
 * activity event: the row is structural metadata with no note to
 * attribute. A `note-folders` realtime event fires only when a row was
 * actually inserted.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param rawPath - Caller-supplied folder path.
 * @returns The normalized persisted path.
 * @throws ForbiddenError when the caller cannot access the project.
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteValidationError when the path is empty or over the cap.
 */
export async function createNoteFolder(
  ctx: AuthContext,
  projectId: string,
  rawPath: string,
): Promise<{ path: string }> {
  assertValidProjectId(projectId);
  const path = normalizeFolder(rawPath);
  if (path === "") {
    throw new NoteValidationError("folder", "folder name cannot be empty");
  }
  const inserted = await withUserContext(ctx.userId, async (tx) => {
    const access = await assertProjectAccessTx(tx, projectId);
    assertProjectWritable(access.project.status, access.project.identifier);
    await acquireProjectLock(tx, projectId);
    const rows = await tx
      .insert(noteFolders)
      .values({ projectId, path, createdBy: ctx.userId })
      .onConflictDoNothing()
      .returning({ id: noteFolders.id });
    return rows.length > 0;
  });
  if (inserted) emitNoteFoldersEvent(projectId);
  return { path };
}

/**
 * Delete a folder's explicit marker rows: the path itself plus every
 * explicit descendant. Notes are untouched; callers soft-delete them
 * separately when emptying a non-empty folder. A `note-folders` realtime
 * event fires only when at least one row was deleted.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param rawPath - Caller-supplied folder path.
 * @returns How many marker rows were deleted.
 * @throws ForbiddenError when the caller cannot access the project.
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteValidationError when the path is empty or over the cap.
 */
export async function deleteNoteFolder(
  ctx: AuthContext,
  projectId: string,
  rawPath: string,
): Promise<{ deletedCount: number }> {
  assertValidProjectId(projectId);
  const path = normalizeFolder(rawPath);
  if (path === "") {
    throw new NoteValidationError("folder", "cannot delete the root folder");
  }
  const deletedCount = await withUserContext(ctx.userId, async (tx) => {
    const access = await assertProjectAccessTx(tx, projectId);
    assertProjectWritable(access.project.status, access.project.identifier);
    await acquireProjectLock(tx, projectId);
    const rows = await tx
      .delete(noteFolders)
      .where(
        and(
          eq(noteFolders.projectId, projectId),
          folderSubtreePredicate(noteFolders.path, path),
        ),
      )
      .returning({ id: noteFolders.id });
    return rows.length;
  });
  if (deletedCount > 0) emitNoteFoldersEvent(projectId);
  return { deletedCount };
}

/**
 * Soft-delete a note (sets `deleted_at`). Idempotent: deleting a trashed
 * note is a no-op, though a stale `ifUpdatedAt` is rejected before the
 * idempotence check. The gate read locks the notes row
 * (`FOR UPDATE OF notes`) so the CAS compare and the write share one
 * locked snapshot. Links and revisions stay in place; read paths filter
 * trashed endpoints, and the FK cascade covers an eventual hard purge.
 * The returned `updatedAt` is the restore-undo CAS token.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @param ifUpdatedAt - Optional CAS precondition from a prior read.
 * @returns The note id, its `deletedAt` instant, and post-delete `updatedAt`.
 * @throws ForbiddenError when the caller cannot access the note.
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteStaleWriteError when `ifUpdatedAt` mismatches.
 * @throws NoteValidationError when `ifUpdatedAt` is malformed.
 */
export async function deleteNote(
  ctx: AuthContext,
  noteId: string,
  ifUpdatedAt?: string,
): Promise<{
  id: string;
  deletedAt: Date;
  updatedAt: Date;
  sequenceNumber: number;
  projectIdentifier: string;
}> {
  assertValidNoteId(noteId);
  const ifUpdatedAtMs =
    ifUpdatedAt === undefined ? undefined : parseIfUpdatedAt(ifUpdatedAt);
  const result = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertNoteAccessTx(tx, noteId, { forUpdate: true });
    assertProjectWritable(gate.projectStatus, gate.projectIdentifier);
    if (gate.locked) throw new NoteLockedError();
    assertAgentWritable(ctx, gate.agentWritable);
    if (
      ifUpdatedAtMs !== undefined &&
      ifUpdatedAtMs !== gate.updatedAt.getTime()
    ) {
      throw new NoteStaleWriteError(gate.updatedAt, gate.version);
    }
    if (gate.deletedAt !== null) {
      return {
        id: gate.id,
        deletedAt: gate.deletedAt,
        updatedAt: gate.updatedAt,
        sequenceNumber: gate.sequenceNumber,
        projectIdentifier: gate.projectIdentifier,
        wasNoOp: true as const,
      };
    }
    const [row] = await tx
      .update(notes)
      .set({
        deletedAt: dbClockStamp(),
        updatedBy: ctx.userId,
        updatedAt: dbClockStamp(),
        metaUpdatedAt: dbClockStamp(),
      })
      .where(eq(notes.id, noteId))
      .returning({
        id: notes.id,
        deletedAt: notes.deletedAt,
        updatedAt: notes.updatedAt,
      });
    await insertActivityEvents(tx, ctx.actor, [
      {
        projectId: gate.projectId,
        taskId: null,
        noteId: gate.id,
        type: "note_deleted",
        targetRef: gate.slug,
        summary: `trashed note "${summaryTitle(gate.title)}"`,
      },
    ]);
    return {
      id: row.id,
      deletedAt: row.deletedAt as Date,
      updatedAt: row.updatedAt,
      sequenceNumber: gate.sequenceNumber,
      projectIdentifier: gate.projectIdentifier,
      wasNoOp: false as const,
      projectId: gate.projectId,
      visibility: gate.visibility,
    };
  });

  if (!result.wasNoOp && "projectId" in result) {
    emitNoteEvent(result.projectId, result.id, result.visibility);
  }
  return {
    id: result.id,
    deletedAt: result.deletedAt,
    updatedAt: result.updatedAt,
    sequenceNumber: result.sequenceNumber,
    projectIdentifier: result.projectIdentifier,
  };
}

/**
 * Restore a trashed note. When a live note has since taken its slug, the
 * restored note is auto-suffixed within its base namespace under the
 * project advisory lock; a free slug is kept as-is. Idempotent on a live
 * note when no `ifUpdatedAt` is given; with a token the compare always
 * runs under the `FOR UPDATE` read, so a stale undo token is rejected
 * even when the note is already live.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @param ifUpdatedAt - Optional CAS precondition (the delete's returned
 *   `updatedAt` for an undo).
 * @returns Slim summary; `slug` may differ from before the delete.
 * @throws ForbiddenError when the caller cannot access the note.
 * @throws ProjectArchivedError when the project is archived.
 * @throws NoteStaleWriteError when `ifUpdatedAt` mismatches.
 * @throws NoteValidationError when `ifUpdatedAt` is malformed.
 */
export async function restoreNote(
  ctx: AuthContext,
  noteId: string,
  ifUpdatedAt?: string,
): Promise<NoteSummary> {
  assertValidNoteId(noteId);
  const ifUpdatedAtMs =
    ifUpdatedAt === undefined ? undefined : parseIfUpdatedAt(ifUpdatedAt);
  const result = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertNoteAccessTx(tx, noteId);
    assertProjectWritable(gate.projectStatus, gate.projectIdentifier);
    assertAgentWritable(ctx, gate.agentWritable);
    if (gate.deletedAt === null && ifUpdatedAtMs === undefined) {
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
    if (
      ifUpdatedAtMs !== undefined &&
      ifUpdatedAtMs !== current.updatedAt.getTime()
    ) {
      throw new NoteStaleWriteError(current.updatedAt, current.version);
    }
    if (current.deletedAt === null) {
      const { deletedAt: _live, ...summary } = current;
      return {
        summary: { ...summary, projectIdentifier: gate.projectIdentifier },
        wasNoOp: true,
        visibility: gate.visibility,
      };
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
        updatedAt: dbClockStamp(),
        metaUpdatedAt: dbClockStamp(),
      })
      .where(eq(notes.id, noteId))
      .returning(noteSummaryColumns);
    await insertActivityEvents(tx, ctx.actor, [
      {
        projectId: gate.projectId,
        taskId: null,
        noteId: gate.id,
        type: "note_restored",
        targetRef: slug,
        summary: `restored note "${summaryTitle(summary.title)}"`,
        metadata: slug === current.slug ? null : { previousSlug: current.slug },
      },
    ]);
    return {
      summary: { ...summary, projectIdentifier: gate.projectIdentifier },
      wasNoOp: false,
      visibility: gate.visibility,
    };
  });

  if (!result.wasNoOp) {
    emitNoteEvent(
      result.summary.projectId,
      result.summary.id,
      result.visibility,
      result.summary.updatedAt,
      result.summary.version,
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
        updatedAt: dbClockStamp(),
      })
      .where(eq(notes.id, noteId))
      .returning(noteSummaryColumns);
    return { ...row, projectIdentifier: gate.projectIdentifier };
  });

  emitNoteEvent(
    summary.projectId,
    summary.id,
    "private",
    summary.updatedAt,
    summary.version,
    undefined,
    false,
  );
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

  emitNoteEvent(
    summary.projectId,
    summary.id,
    "team",
    summary.updatedAt,
    summary.version,
  );
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
        updatedAt: dbClockStamp(),
      })
      .where(eq(notes.id, gate.id))
      .returning(noteSummaryColumns);
    return { ...row, projectIdentifier: gate.projectIdentifier };
  });

  emitNoteEvent(
    summary.projectId,
    summary.id,
    "private",
    summary.updatedAt,
    summary.version,
    undefined,
    false,
  );
  return summary;
}

/**
 * Shared visibility write: updates the column, clears the share-request
 * marker and stamps `shared_since` (DB `now()`) when flipping to `team`,
 * clears `shared_since` when flipping to `private`, and records the
 * activity event. Bumps both note clocks — a visibility flip changes which
 * members' graph payloads contain the note, so the graph ETag must move
 * (this path serves {@link approveShareRequest}, which bypasses
 * `updateNote`'s field-based bump).
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
      ...(visibility === "team"
        ? { shareRequestedBy: null, sharedSince: sql`now()` }
        : { sharedSince: null }),
      updatedBy: ctx.userId,
      updatedAt: dbClockStamp(),
      metaUpdatedAt: dbClockStamp(),
    })
    .where(eq(notes.id, gate.id))
    .returning(noteSummaryColumns);
  await insertActivityEvents(tx, ctx.actor, [
    {
      projectId: gate.projectId,
      taskId: null,
      noteId: gate.id,
      type: "note_updated",
      targetRef: row.slug,
      summary: `updated note "${summaryTitle(row.title)}"`,
      metadata: { fields: ["visibility"], version: row.version },
    },
  ]);
  return { ...row, projectIdentifier: gate.projectIdentifier };
}

// ---------------------------------------------------------------------------
// Agent-surface reads and deliberate links (piyaz_note)
// ---------------------------------------------------------------------------

/**
 * Tree list plus the owning project identifier, for callers composing
 * noteRefs (`PYZ-N12`) per row, plus the explicit `note_folders` paths so
 * the agent tree shows empty folders the web tree shows. Same one-batch
 * read as {@link getNoteTreeList} with the folder paths joined in.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns The project identifier, tree rows ordered by folder then
 *   title, and explicit folder paths ordered by path.
 * @throws ForbiddenError when the caller cannot access the project.
 */
export async function getNoteTreeForAgent(
  ctx: AuthContext,
  projectId: string,
): Promise<{
  projectIdentifier: string;
  rows: NoteTreeRow[];
  explicitFolders: string[];
}> {
  assertValidProjectId(projectId);
  const [gateRows, treeRows, folderRows] = await withUserContextRead(
    ctx.userId,
    (read) => [
      projectAccessGateStmt(read, projectId),
      noteTreeListStmt(read, projectId),
      read
        .select({ path: noteFolders.path })
        .from(noteFolders)
        .where(eq(noteFolders.projectId, projectId))
        .orderBy(asc(noteFolders.path)),
    ],
  );
  const gate = assertProjectGateRows(projectId, gateRows);
  return {
    projectIdentifier: gate.identifier,
    rows: treeRows,
    explicitFolders: folderRows.map((row) => row.path),
  };
}

/**
 * Note search for MCP, structured as task MCP search is: a whole noteRef
 * resolves exactly, everything else is fuzzy (title/summary/tag substring,
 * then ranked full text). Ref fragments do not match here; agents resolve
 * refs whole, as `piyaz_search` does for tasks. Returns the owning project
 * identifier for callers composing noteRefs per hit. RLS-scoped like
 * {@link searchNotes}: team notes regardless of feed mode plus the
 * caller's own private notes. Feed exposure gates bundle injection, never
 * search (Notes spec §14.3).
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project to search in.
 * @param query - User search text.
 * @returns The project identifier and merged hits, substring tier first.
 * @throws ForbiddenError when the caller cannot access the project.
 * @throws NoteValidationError when the query exceeds the length cap.
 */
export async function searchNotesForMcp(
  ctx: AuthContext,
  projectId: string,
  query: string,
): Promise<{ projectIdentifier: string; hits: NoteSearchHit[] }> {
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
    const gate = assertProjectGateRows(projectId, gateRows);
    return { projectIdentifier: gate.identifier, hits: [] };
  }
  return await searchProjectNotes(ctx, projectId, trimmed, false);
}

/** The deliberate (caller-managed) note-task link kinds; `mention` is derivation-owned. */
export type DeliberateNoteTaskLinkKind = Exclude<NoteTaskLinkKind, "mention">;

/**
 * Create a deliberate note-task link (`reference` or `spec_of`).
 * Idempotent: an existing identical link returns `created: false`.
 * `mention` rows are owned by body-link derivation and cannot be created
 * here. Both endpoints must be live, accessible, and in the same project
 * (the DB trigger rejects cross-project rows; this pre-check keeps the
 * rejection typed). A created link bumps BOTH note clocks in the same
 * transaction — `updated_at` for the context ETag and `meta_updated_at`
 * for the graph ETag: the link tables carry only `created_at`, so without
 * the bumps the note-inclusive validators would miss the change.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @param taskId - UUID of the task.
 * @param kind - Link kind.
 * @returns Whether a row was inserted, plus the note's ref parts.
 * @throws ForbiddenError on inaccessible or trashed endpoints.
 * @throws ProjectArchivedError when the project is archived.
 * @throws CrossProjectNoteLinkError when the endpoints span projects.
 */
export async function createNoteTaskLink(
  ctx: AuthContext,
  noteId: string,
  taskId: string,
  kind: DeliberateNoteTaskLinkKind,
): Promise<{
  created: boolean;
  sequenceNumber: number;
  projectIdentifier: string;
}> {
  assertValidNoteId(noteId);
  assertValidTaskId(taskId);
  const result = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertNoteAccessTx(tx, noteId);
    assertNoteLive(gate);
    assertProjectWritable(gate.projectStatus, gate.projectIdentifier);
    if (gate.locked) throw new NoteLockedError();
    assertAgentWritable(ctx, gate.agentWritable);
    const task = await assertTaskAccessTx(tx, taskId);
    if (task.projectId !== gate.projectId) {
      throw new CrossProjectNoteLinkError();
    }
    const rows = await tx
      .insert(noteTaskLinks)
      .values({ noteId, taskId, kind })
      .onConflictDoNothing()
      .returning({ id: noteTaskLinks.id });
    const created = rows.length > 0;
    if (created) {
      await tx
        .update(notes)
        .set({ updatedAt: dbClockStamp(), metaUpdatedAt: dbClockStamp() })
        .where(eq(notes.id, noteId));
      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId: gate.projectId,
          taskId,
          noteId: gate.id,
          type: "note_updated",
          targetRef: gate.slug,
          summary: `linked note "${summaryTitle(gate.title)}" to a task`,
          metadata: { fields: ["links"], kind },
        },
      ]);
    }
    return { created, gate };
  });

  if (result.created) {
    emitNoteEvent(
      result.gate.projectId,
      noteId,
      result.gate.visibility,
      undefined,
      result.gate.version,
    );
  }
  return {
    created: result.created,
    sequenceNumber: result.gate.sequenceNumber,
    projectIdentifier: result.gate.projectIdentifier,
  };
}

/**
 * Remove a deliberate note-task link (`reference` or `spec_of`).
 * `mention` rows are owned by body-link derivation and cannot be removed
 * here. Removing an absent link returns `removed: false`. A removed link
 * bumps BOTH note clocks in the same transaction (`updated_at` for the
 * context ETag, `meta_updated_at` for the graph ETag) so the note-inclusive
 * validators observe the change.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @param taskId - UUID of the task.
 * @param kind - Link kind.
 * @returns Whether a row was deleted, plus the note's ref parts.
 * @throws ForbiddenError on an inaccessible or trashed note.
 * @throws ProjectArchivedError when the project is archived.
 */
export async function removeNoteTaskLink(
  ctx: AuthContext,
  noteId: string,
  taskId: string,
  kind: DeliberateNoteTaskLinkKind,
): Promise<{
  removed: boolean;
  sequenceNumber: number;
  projectIdentifier: string;
}> {
  assertValidNoteId(noteId);
  assertValidTaskId(taskId);
  const result = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertNoteAccessTx(tx, noteId);
    assertNoteLive(gate);
    assertProjectWritable(gate.projectStatus, gate.projectIdentifier);
    if (gate.locked) throw new NoteLockedError();
    assertAgentWritable(ctx, gate.agentWritable);
    const rows = await tx
      .delete(noteTaskLinks)
      .where(
        and(
          eq(noteTaskLinks.noteId, noteId),
          eq(noteTaskLinks.taskId, taskId),
          eq(noteTaskLinks.kind, kind),
        ),
      )
      .returning({ id: noteTaskLinks.id });
    const removed = rows.length > 0;
    if (removed) {
      await tx
        .update(notes)
        .set({ updatedAt: dbClockStamp(), metaUpdatedAt: dbClockStamp() })
        .where(eq(notes.id, noteId));
      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId: gate.projectId,
          taskId,
          noteId: gate.id,
          type: "note_updated",
          targetRef: gate.slug,
          summary: `unlinked note "${summaryTitle(gate.title)}" from a task`,
          metadata: { fields: ["links"], kind },
        },
      ]);
    }
    return { removed, gate };
  });

  if (result.removed) {
    emitNoteEvent(
      result.gate.projectId,
      noteId,
      result.gate.visibility,
      undefined,
      result.gate.version,
    );
  }
  return {
    removed: result.removed,
    sequenceNumber: result.gate.sequenceNumber,
    projectIdentifier: result.gate.projectIdentifier,
  };
}

/** Slim revision descriptor; never carries `body`. */
export type NoteRevisionMeta = {
  version: number;
  title: string;
  createdBy: string | null;
  createdAt: Date;
};

/** One revision snapshot, body included. */
export type NoteRevisionSnapshot = NoteRevisionMeta & { body: string };

/**
 * List a live note's revision descriptors, newest first. The retention
 * cap prunes past {@link NOTE_REVISION_KEEP}, so the list is bounded.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @returns The note's ref parts, live version, and revision descriptors.
 * @throws ForbiddenError on inaccessible or trashed notes.
 */
export async function listNoteRevisions(
  ctx: AuthContext,
  noteId: string,
): Promise<{
  sequenceNumber: number;
  projectIdentifier: string;
  currentVersion: number;
  revisions: NoteRevisionMeta[];
}> {
  assertValidNoteId(noteId);
  const [gateRows, revisionRows] = await withUserContextRead(
    ctx.userId,
    (read) => [
      noteAccessGateStmt(read, noteId),
      read
        .select({
          version: noteRevisions.version,
          title: noteRevisions.title,
          createdBy: noteRevisions.createdBy,
          createdAt: noteRevisions.createdAt,
        })
        .from(noteRevisions)
        .where(eq(noteRevisions.noteId, noteId))
        .orderBy(desc(noteRevisions.version)),
    ],
  );
  const gate = assertNoteGateRows(noteId, gateRows);
  assertNoteLive(gate);
  return {
    sequenceNumber: gate.sequenceNumber,
    projectIdentifier: gate.projectIdentifier,
    currentVersion: gate.version,
    revisions: revisionRows,
  };
}

/**
 * Resolve a live note's revision-list validator parts without fetching the
 * descriptors: the live version plus the stored-checkpoint extent
 * (`max(version)`, row count) the caller's RLS window can see. One
 * RLS-scoped batch (access gate + one aggregate over the `(note_id,
 * version)` index): the cheap validator resolve for `HEAD`/
 * `If-None-Match`, so a 304 skips the full descriptor fetch.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @returns Live version, max stored version (0 when none), and row count.
 * @throws ForbiddenError on inaccessible or trashed notes.
 */
export async function getNoteRevisionsVersion(
  ctx: AuthContext,
  noteId: string,
): Promise<{ currentVersion: number; maxVersion: number; count: number }> {
  assertValidNoteId(noteId);
  const [gateRows, extentRows] = await withUserContextRead(
    ctx.userId,
    (read) => [
      noteAccessGateStmt(read, noteId),
      read
        .select({
          maxVersion: sql<number>`COALESCE(MAX(${noteRevisions.version}), 0)::int`,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(noteRevisions)
        .where(eq(noteRevisions.noteId, noteId)),
    ],
  );
  const gate = assertNoteGateRows(noteId, gateRows);
  assertNoteLive(gate);
  const [extent] = extentRows;
  return {
    currentVersion: gate.version,
    maxVersion: extent?.maxVersion ?? 0,
    count: extent?.count ?? 0,
  };
}

/**
 * Read one revision snapshot of a live note. A missing version returns a
 * null snapshot plus the available version numbers, so callers can emit
 * a corrective message without a second round trip.
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @param version - Revision counter value to read.
 * @returns The snapshot or null, plus available versions and ref parts.
 * @throws ForbiddenError on inaccessible or trashed notes.
 */
export async function getNoteRevision(
  ctx: AuthContext,
  noteId: string,
  version: number,
): Promise<{
  snapshot: NoteRevisionSnapshot | null;
  availableVersions: number[];
  sequenceNumber: number;
  projectIdentifier: string;
}> {
  assertValidNoteId(noteId);
  const [gateRows, snapshotRows, versionRows] = await withUserContextRead(
    ctx.userId,
    (read) => [
      noteAccessGateStmt(read, noteId),
      read
        .select({
          version: noteRevisions.version,
          title: noteRevisions.title,
          body: noteRevisions.body,
          createdBy: noteRevisions.createdBy,
          createdAt: noteRevisions.createdAt,
        })
        .from(noteRevisions)
        .where(
          and(
            eq(noteRevisions.noteId, noteId),
            eq(noteRevisions.version, version),
          ),
        )
        .limit(1),
      read
        .select({ version: noteRevisions.version })
        .from(noteRevisions)
        .where(eq(noteRevisions.noteId, noteId))
        .orderBy(desc(noteRevisions.version)),
    ],
  );
  const gate = assertNoteGateRows(noteId, gateRows);
  assertNoteLive(gate);
  return {
    snapshot: snapshotRows[0] ?? null,
    availableVersions: versionRows.map((row) => row.version),
    sequenceNumber: gate.sequenceNumber,
    projectIdentifier: gate.projectIdentifier,
  };
}

/**
 * Restore a note's title and body to a stored revision snapshot by writing
 * through {@link updateNote}, an append-only revert: the pre-restore live
 * state is checkpointed unconditionally and `version` bumps, so nothing is
 * destroyed. The snapshot read and the write are separate transactions by
 * design: revisions are append-only-immutable (`note_revisions` is
 * UPDATE-revoked), so the read cannot go stale, and note concurrency is
 * owned by `updateNote`'s CAS + `FOR UPDATE` lock. Locked, agent-read-only, and archived-project
 * rejections are inherited; restoring content identical to the live note is
 * a no-op (no event, no version bump).
 *
 * @param ctx - Resolved auth context.
 * @param noteId - UUID of the note.
 * @param version - Revision counter value to restore.
 * @param opts - `ifUpdatedAt` CAS precondition from a prior read.
 * @returns Slim summary of the restored note (plus re-derived `links` on a
 *   body change).
 * @throws ForbiddenError on inaccessible or trashed notes.
 * @throws NoteValidationError when the version does not exist, naming the
 *   available versions.
 * @throws NoteStaleWriteError when `ifUpdatedAt` mismatches.
 * @throws NoteLockedError when the note is locked.
 * @throws ProjectArchivedError when the project is archived.
 */
export async function restoreNoteRevision(
  ctx: AuthContext,
  noteId: string,
  version: number,
  opts?: { ifUpdatedAt?: string },
): Promise<NoteSummary & { links?: NoteLinksRefresh }> {
  if (!Number.isInteger(version) || version < 1) {
    throw new NoteValidationError(
      "version",
      "version must be a positive integer",
    );
  }
  const { snapshot, availableVersions } = await getNoteRevision(
    ctx,
    noteId,
    version,
  );
  if (snapshot === null) {
    throw new NoteValidationError(
      "version",
      `version ${version} not found; available versions: ${availableVersions.join(", ")}`,
    );
  }
  return updateNote(
    ctx,
    noteId,
    { title: snapshot.title, body: snapshot.body },
    opts?.ifUpdatedAt,
    { restoredFromVersion: version },
  );
}
