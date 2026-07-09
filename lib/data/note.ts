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
} from "drizzle-orm";
import type { AuthContext } from "@/lib/auth/context";
import {
  assertNoteAccessTx,
  assertNoteGateRows,
  assertProjectAccessTx,
  assertProjectGateRows,
  assertTaskAccessTx,
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
  noteFolders,
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
  noteFoldersVersionStmt,
  type NoteFoldersVersionRow,
} from "@/lib/db/raw/get-note-folders-version";
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
import { BatchInputError } from "@/lib/data/task-batch";
import { InvalidEditOpError } from "@/lib/data/task-edit";
import { foldTextOp, type TextOp } from "@/lib/data/text-ops";
import { ProjectArchivedError } from "@/lib/graph/errors";
import {
  asIdentifier,
  composeNoteRef,
  composeTaskRef,
} from "@/lib/graph/identifier";
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

/** Slim tree-list row; never carries `body` or `search_tsv`. */
export type NoteTreeRow = {
  id: string;
  slug: string;
  sequenceNumber: number;
  title: string;
  type: NoteType;
  folder: string;
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

/** Full note row minus the server-side `search_tsv` column. */
export type NoteFull = Omit<Note, "searchTsv">;

/** Single-note read: the full row plus its derived link context. */
export type NoteFullResult = {
  note: NoteFull;
  projectIdentifier: string;
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
  sequenceNumber: number;
  noteRef: string;
  updatedAt: Date;
};

/** Pointer to an exposed note that overflowed the feed budget. */
export type NoteFeedPointer = {
  id: string;
  slug: string;
  title: string;
  type: NoteType;
  sequenceNumber: number;
  noteRef: string;
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
} as const;

/** Slim tree-list projection; excludes `body` and `search_tsv` by design. */
const noteTreeColumns = {
  id: notes.id,
  slug: notes.slug,
  sequenceNumber: notes.sequenceNumber,
  title: notes.title,
  type: notes.type,
  folder: notes.folder,
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
export function normalizeFolder(raw: string): string {
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
  const [gateRows, noteRows, mentionRows, linksOut, linksIn] =
    await withUserContextRead(ctx.userId, (read) => [
      noteAccessGateStmt(read, noteId),
      noteRowStmt(read, noteId),
      noteMentionsStmt(read, noteId),
      noteLinksOutStmt(read, noteId),
      noteLinksInStmt(read, noteId),
    ]);
  const gate = assertNoteGateRows(noteId, gateRows);
  const [note] = noteRows;
  if (!note) throw new ForbiddenError("Forbidden", "note", noteId);
  return {
    note,
    projectIdentifier: gate.projectIdentifier,
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
  const [gateRows, noteRows] = await withUserContextRead(ctx.userId, (read) => [
    noteAccessGateStmt(read, noteId),
    read
      .select(noteScalarColumns)
      .from(notes)
      .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
      .limit(1),
  ]);
  const gate = assertNoteGateRows(noteId, gateRows);
  const [row] = noteRows;
  if (!row) throw new ForbiddenError("Forbidden", "note", noteId);
  return {
    note: { ...row, body: "" },
    projectIdentifier: gate.projectIdentifier,
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
  return normalizeExecuteResult<NoteSearchRawRow>(hitsRaw).map(toSearchHit);
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
      charLen(rows[i].title) + charLen(rows[i].summary) + charLen(rows[i].body);
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
    body: row.body ?? "",
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

  emitNoteEvent(created.projectId, created.id, visibility, created.updatedAt);
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
 * team-visibility activity event. The caller must have gated project
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
      summary: input.summary ?? "",
      tags: input.tags ?? [],
      category: input.category ?? null,
      feedMode: input.feedMode ?? "none",
      feedCategories: canonicalizeFeedLabels(input.feedCategories ?? []),
      feedTags: canonicalizeFeedLabels(input.feedTags ?? []),
      feedTaskIds: canonicalizeFeedLabels(input.feedTaskIds ?? []),
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
    emitNoteEvent(note.projectId, note.id, opts.visibility, note.updatedAt);
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
  return updateNoteCore(ctx, noteId, patch, ifUpdatedAt);
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
 * @returns Slim summary; a body change also carries the re-derived links.
 */
async function updateNoteCore(
  ctx: AuthContext,
  noteId: string,
  patch: NotePatch,
  ifUpdatedAt?: string,
  bodyOps?: TextOp[],
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
    return {
      summary: { ...summary, projectIdentifier: current.projectIdentifier },
      wasNoOp: false,
      visibility: nextVisibility,
      links,
    };
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
    if (gate.locked) throw new NoteLockedError();
    assertAgentWritable(ctx, gate.agentWritable);
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
 * old paths — a definer-privileged bulk write would let members rewrite
 * paths of notes they cannot see. The activity event and project
 * dispatch fire only when a team-visible note actually moved.
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
    const [guard] = await tx
      .select({
        lockedCount: sql<number>`count(*) filter (where ${notes.locked})`,
        readOnlyCount: sql<number>`count(*) filter (where not ${notes.agentWritable})`,
        longest: sql<number | null>`max(char_length(${notes.folder}))`,
      })
      .from(notes)
      .where(subtreeFilter);
    if (Number(guard?.lockedCount ?? 0) > 0) throw new NoteLockedError();
    if (ctx.actor.source === "mcp" && Number(guard?.readOnlyCount ?? 0) > 0) {
      throw new NoteAgentReadOnlyError();
    }
    const explicitSubtreeFilter = and(
      eq(noteFolders.projectId, projectId),
      or(
        eq(noteFolders.path, srcPath),
        like(noteFolders.path, `${escapeLike(srcPath)}/%`),
      ),
    );
    const [explicitGuard] = await tx
      .select({
        longest: sql<number | null>`max(char_length(${noteFolders.path}))`,
      })
      .from(noteFolders)
      .where(explicitSubtreeFilter);
    const longest = Math.max(guard?.longest ?? 0, explicitGuard?.longest ?? 0);
    if (growth > 0 && longest + growth > FOLDER_MAX_CHARS) {
      throw new NoteValidationError(
        "folder",
        `move would push a descendant past ${FOLDER_MAX_CHARS} characters`,
      );
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
 * Persist an explicitly created empty folder as a `note_folders` marker
 * row. Idempotent: a duplicate create upserts into the existing row via
 * `onConflictDoNothing` on the `(project_id, path)` unique index. No
 * activity event — the row is structural metadata with no note to
 * attribute.
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
  await withUserContext(ctx.userId, async (tx) => {
    const access = await assertProjectAccessTx(tx, projectId);
    assertProjectWritable(access.project.status, access.project.identifier);
    await acquireProjectLock(tx, projectId);
    await tx
      .insert(noteFolders)
      .values({ projectId, path, createdBy: ctx.userId })
      .onConflictDoNothing();
  });
  return { path };
}

/**
 * Delete a folder's explicit marker rows: the path itself plus every
 * explicit descendant. Notes are untouched — callers soft-delete them
 * separately when emptying a non-empty folder.
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
          or(
            eq(noteFolders.path, path),
            like(noteFolders.path, `${escapeLike(path)}/%`),
          ),
        ),
      )
      .returning({ id: noteFolders.id });
    return rows.length;
  });
  return { deletedCount };
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
): Promise<{
  id: string;
  deletedAt: Date;
  sequenceNumber: number;
  projectIdentifier: string;
}> {
  assertValidNoteId(noteId);
  const result = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertNoteAccessTx(tx, noteId);
    assertProjectWritable(gate.projectStatus, gate.projectIdentifier);
    if (gate.locked) throw new NoteLockedError();
    assertAgentWritable(ctx, gate.agentWritable);
    if (gate.deletedAt !== null) {
      return {
        id: gate.id,
        deletedAt: gate.deletedAt,
        sequenceNumber: gate.sequenceNumber,
        projectIdentifier: gate.projectIdentifier,
        wasNoOp: true as const,
      };
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
    sequenceNumber: result.sequenceNumber,
    projectIdentifier: result.projectIdentifier,
  };
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
    assertAgentWritable(ctx, gate.agentWritable);
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
    return { ...row, projectIdentifier: gate.projectIdentifier };
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
    return { ...row, projectIdentifier: gate.projectIdentifier };
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
  return { ...row, projectIdentifier: gate.projectIdentifier };
}

// ---------------------------------------------------------------------------
// Agent-surface reads and deliberate links (piyaz_note)
// ---------------------------------------------------------------------------

/**
 * Tree list plus the owning project identifier, for callers composing
 * noteRefs (`PYZ-N12`) per row. Same one-batch read as
 * {@link getNoteTreeList}.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns The project identifier and tree rows ordered by folder, title.
 * @throws ForbiddenError when the caller cannot access the project.
 */
export async function getNoteTreeForAgent(
  ctx: AuthContext,
  projectId: string,
): Promise<{ projectIdentifier: string; rows: NoteTreeRow[] }> {
  assertValidProjectId(projectId);
  const [gateRows, treeRows] = await withUserContextRead(ctx.userId, (read) => [
    projectAccessGateStmt(read, projectId),
    noteTreeListStmt(read, projectId),
  ]);
  const gate = assertProjectGateRows(projectId, gateRows);
  return { projectIdentifier: gate.identifier, rows: treeRows };
}

/**
 * Ranked note search plus the owning project identifier, for callers
 * composing noteRefs per hit. RLS-scoped like {@link searchNotes}: team
 * notes regardless of feed mode plus the caller's own private notes.
 * Feed exposure gates bundle injection, never search (Notes spec §14.3).
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project to search in.
 * @param query - User search text.
 * @returns The project identifier and up to 20 hits, best rank first.
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
  const [gateRows, hitsRaw] = await withUserContextRead(ctx.userId, (read) => [
    projectAccessGateStmt(read, projectId),
    noteSearchStmt(read, projectId, trimmed),
  ]);
  const gate = assertProjectGateRows(projectId, gateRows);
  return {
    projectIdentifier: gate.identifier,
    hits: normalizeExecuteResult<NoteSearchRawRow>(hitsRaw).map(toSearchHit),
  };
}

/** The deliberate (caller-managed) note-task link kinds; `mention` is derivation-owned. */
export type DeliberateNoteTaskLinkKind = Exclude<NoteTaskLinkKind, "mention">;

/**
 * Create a deliberate note-task link (`reference` or `spec_of`).
 * Idempotent: an existing identical link returns `created: false`.
 * `mention` rows are owned by body-link derivation and cannot be created
 * here. Both endpoints must be live, accessible, and in the same project
 * (the DB trigger rejects cross-project rows; this pre-check keeps the
 * rejection typed).
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
    if (created && gate.visibility === "team") {
      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId: gate.projectId,
          taskId,
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
    emitNoteEvent(result.gate.projectId, noteId, result.gate.visibility);
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
 * here. Removing an absent link returns `removed: false`.
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
    if (removed && gate.visibility === "team") {
      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId: gate.projectId,
          taskId,
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
    emitNoteEvent(result.gate.projectId, noteId, result.gate.visibility);
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
