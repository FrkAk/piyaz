import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
  check,
  unique,
  uniqueIndex,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { organization, user } from "@/lib/db/auth-schema";
import type {
  ProjectStatus,
  TaskStatus,
  EdgeType,
  Decision,
  Priority,
  Estimate,
  ActivityEventType,
  ActivitySource,
  NoteType,
  Visibility,
  FeedMode,
  NoteTaskLinkKind,
  EmbeddingStatus,
  LegalDocumentType,
} from "@/lib/types";

/**
 * Postgres `tsvector` column type. Drizzle ships no builtin; this maps the
 * generated full-text search column (`notes.search_tsv`) to a string in TS.
 */
const tsvector = customType<{ data: string }>({
  /**
   * SQL type name emitted for the column.
   *
   * @returns The literal `tsvector` type name.
   */
  dataType() {
    return "tsvector";
  },
});

/**
 * Byte cap for `notes.title`, `notes.slug`, and `note_revisions.title`.
 * Titles and slugs sit in btree indexes (notes_project_title_idx,
 * notes_project_slug_unique); a value past the ~2704-byte btree tuple limit
 * aborts the write with an opaque "index row size exceeds maximum", so the
 * cap keeps oversize values failing as a clean 23514 instead.
 */
export const NOTE_TITLE_MAX_BYTES = 2000;

/**
 * Char cap for `notes.body` and `note_revisions.body` — the call-surface
 * contract for the largest storable note. A revision snapshots its source
 * note, so both tables share the cap.
 */
export const NOTE_BODY_MAX_CHARS = 200_000;

/**
 * Chars of `body` indexed into the generated `search_tsv`.
 *
 * A tsvector must stay under 1,048,575 bytes of lexeme + position data
 * (PG "Text Search Limits"), and a char-count CHECK cannot bound that
 * directly: the worst case — space-separated distinct two-part hyphenated
 * compounds of single 4-byte chars ("𠀀-𠀁") — yields three lexemes per token
 * (whole + both parts), ~30 tsvector bytes per 4 body chars (7.5 bytes/char,
 * measured on postgres:18, where 163k such chars overflow an unbounded
 * column). 131072 body chars × 7.5 + 2000 title chars × 7.5 ≈ 998 KB, under
 * the cap with margin. Bodies keep the full NOTE_BODY_MAX_CHARS; search
 * ignores chars past this bound.
 */
export const NOTE_SEARCH_INDEXED_CHARS = 131_072;

/**
 * Inline an integer constant into SQL DDL text.
 *
 * drizzle-kit serializes CHECK and generated-column expressions into the
 * migration snapshot; a plain `${n}` interpolation becomes a `$1` placeholder
 * there, so DDL constants must be embedded as raw literal text.
 *
 * @param n - Integer to embed.
 * @returns Raw SQL chunk containing the literal.
 */
function sqlInt(n: number): SQL {
  return sql.raw(String(n));
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    identifier: text("identifier").notNull(),
    description: text("description").notNull().default(""),
    status: text("status")
      .$type<ProjectStatus>()
      .notNull()
      .default("brainstorming"),
    categories: jsonb("categories").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("projects_organization_id_idx").on(t.organizationId),
    unique("projects_org_identifier_unique").on(t.organizationId, t.identifier),
  ],
).enableRLS();

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<TaskStatus>().notNull().default("draft"),
    order: integer("order").notNull().default(0),
    category: text("category"),
    implementationPlan: text("implementation_plan"),
    executionRecord: text("execution_record"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    priority: text("priority").$type<Priority>(),
    estimate: integer("estimate").$type<Estimate>(),
    files: jsonb("files").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tasks_project_id_idx").on(t.projectId),
    unique("tasks_project_sequence_unique").on(t.projectId, t.sequenceNumber),
  ],
).enableRLS();

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

// ---------------------------------------------------------------------------
// Task Edges
// ---------------------------------------------------------------------------

export const taskEdges = pgTable(
  "task_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceTaskId: uuid("source_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    targetTaskId: uuid("target_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    edgeType: text("edge_type").$type<EdgeType>().notNull(),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("task_edges_source_idx").on(t.sourceTaskId),
    index("task_edges_target_idx").on(t.targetTaskId),
    uniqueIndex("task_edges_unique_idx").on(
      t.sourceTaskId,
      t.targetTaskId,
      t.edgeType,
    ),
  ],
).enableRLS();

export type TaskEdge = typeof taskEdges.$inferSelect;
export type NewTaskEdge = typeof taskEdges.$inferInsert;

// ---------------------------------------------------------------------------
// Task Assignees (junction table; many-to-many tasks ↔ users)
// ---------------------------------------------------------------------------

export const taskAssignees = pgTable(
  "task_assignees",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.userId] }),
    index("task_assignees_user_id_idx").on(t.userId),
  ],
).enableRLS();

export type TaskAssignee = typeof taskAssignees.$inferSelect;
export type NewTaskAssignee = typeof taskAssignees.$inferInsert;

// ---------------------------------------------------------------------------
// Task Acceptance Criteria (replaces tasks.acceptance_criteria JSONB)
// ---------------------------------------------------------------------------

export const taskAcceptanceCriteria = pgTable(
  "task_acceptance_criteria",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    checked: boolean("checked").notNull().default(false),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("task_acceptance_criteria_task_id_position_idx").on(
      t.taskId,
      t.position,
    ),
    unique("task_acceptance_criteria_task_id_text_unique").on(t.taskId, t.text),
  ],
).enableRLS();

export type TaskAcceptanceCriterion =
  typeof taskAcceptanceCriteria.$inferSelect;
export type NewTaskAcceptanceCriterion =
  typeof taskAcceptanceCriteria.$inferInsert;

// ---------------------------------------------------------------------------
// Task Decisions (replaces tasks.decisions JSONB)
// ---------------------------------------------------------------------------

export const taskDecisions = pgTable(
  "task_decisions",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    source: text("source").$type<Decision["source"]>().notNull(),
    decisionDate: text("decision_date").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("task_decisions_task_id_position_idx").on(t.taskId, t.position),
    unique("task_decisions_task_id_text_unique").on(t.taskId, t.text),
  ],
).enableRLS();

export type TaskDecision = typeof taskDecisions.$inferSelect;
export type NewTaskDecision = typeof taskDecisions.$inferInsert;

// ---------------------------------------------------------------------------
// Task Links (URLs attached to a task: PRs, issues, commits, docs, etc.)
// ---------------------------------------------------------------------------

export const taskLinks = pgTable(
  "task_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    url: text("url").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("task_links_task_id_idx").on(t.taskId),
    unique("task_links_task_url_unique").on(t.taskId, t.url),
  ],
).enableRLS();

export type TaskLink = typeof taskLinks.$inferSelect;
export type NewTaskLink = typeof taskLinks.$inferInsert;

// ---------------------------------------------------------------------------
// Activity Events (append-only audit log for tasks + projects)
// ---------------------------------------------------------------------------

export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    noteId: uuid("note_id").references(() => notes.id, { onDelete: "cascade" }),
    type: text("type").$type<ActivityEventType>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    actorUserId: uuid("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    source: text("source").$type<ActivitySource>().notNull(),
    actorClientId: text("actor_client_id"),
    summary: text("summary").notNull(),
    targetRef: text("target_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("activity_events_task_id_created_idx").on(t.taskId, t.createdAt),
    index("activity_events_note_id_created_idx")
      .on(t.noteId, t.createdAt)
      .where(sql`note_id IS NOT NULL`),
    index("activity_events_project_id_created_idx").on(
      t.projectId,
      t.createdAt,
    ),
    index("activity_events_actor_user_id_idx").on(t.actorUserId),
    check(
      "activity_events_source_check",
      sql`${t.source} IN ('web', 'mcp', 'system')`,
    ),
    check(
      "activity_events_note_ref_check",
      sql`${t.type} NOT LIKE 'note\\_%' OR ${t.noteId} IS NOT NULL`,
    ),
  ],
).enableRLS();

export type ActivityEventRow = typeof activityEvents.$inferSelect;
export type NewActivityEvent = typeof activityEvents.$inferInsert;

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Per-project note ref sequence. `0` is the "unassigned" sentinel the
    // notes_assign_sequence BEFORE INSERT trigger replaces with the next
    // per-project value (docker/rls-functions.sql); writers never set it.
    sequenceNumber: integer("sequence_number").notNull().default(0),
    type: text("type").$type<NoteType>().notNull().default("reference"),
    folder: text("folder").notNull().default(""),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    summary: text("summary").notNull().default(""),
    body: text("body").notNull().default(""),
    visibility: text("visibility")
      .$type<Visibility>()
      .notNull()
      .default("private"),
    // Start of the current team-visible period (DB now() at creation for
    // team notes and at each private->team flip; NULL while private). The
    // RLS fence on activity_events and note_revisions compares row
    // created_at against it so pre-share history stays creator-only.
    sharedSince: timestamp("shared_since", { withTimezone: true }),
    agentWritable: boolean("agent_writable").notNull().default(false),
    locked: boolean("locked").notNull().default(false),
    feedMode: text("feed_mode").$type<FeedMode>().notNull().default("none"),
    feedCategories: jsonb("feed_categories")
      .$type<string[]>()
      .notNull()
      .default([]),
    feedTags: jsonb("feed_tags").$type<string[]>().notNull().default([]),
    feedTaskIds: jsonb("feed_task_ids").$type<string[]>().notNull().default([]),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    category: text("category"),
    version: integer("version").notNull().default(1),
    embeddingStatus: text("embedding_status")
      .$type<EmbeddingStatus>()
      .notNull()
      .default("none"),
    // A pending share request IS this column being set — there is no separate
    // boolean to keep in sync. Clearing it resolves the request, and the FK's
    // ON DELETE SET NULL auto-cancels a request whose requester was deleted
    // (an unattributable pending request must never stay approvable).
    shareRequestedBy: uuid("share_requested_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Consumed only server-side by notes_search_idx and large (up to hundreds
    // of KB for a max-size body): reads must project explicit columns that
    // exclude it — a bare select() ships it over the wire on every row.
    // left() bounds the indexed input so the STORED tsvector stays under
    // Postgres's 1 MB cap; NOTE_SEARCH_INDEXED_CHARS carries the math.
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', left(coalesce(title, ''), ${sqlInt(NOTE_TITLE_MAX_BYTES)})), 'A') || setweight(to_tsvector('english', left(coalesce(body, ''), ${sqlInt(NOTE_SEARCH_INDEXED_CHARS)})), 'B')`,
    ),
  },
  (t) => [
    index("notes_project_id_idx").on(t.projectId),
    unique("notes_project_sequence_unique").on(t.projectId, t.sequenceNumber),
    uniqueIndex("notes_project_slug_unique")
      .on(t.projectId, t.slug)
      .where(sql`deleted_at IS NULL`),
    index("notes_project_title_idx")
      .on(t.projectId, t.title)
      .where(sql`deleted_at IS NULL`),
    // Serves the wiki-link title resolution on every body write, which
    // filters on LOWER(title) and would otherwise scan the project's notes
    // inside the locked write transaction.
    index("notes_project_title_lower_idx")
      .on(t.projectId, sql`lower(${t.title})`)
      .where(sql`deleted_at IS NULL`),
    index("notes_search_idx").using("gin", t.searchTsv),
    index("notes_tags_idx").using("gin", t.tags),
    index("notes_feed_idx")
      .on(t.projectId, t.feedMode)
      .where(sql`feed_mode <> 'none'`),
    index("notes_embedding_status_idx")
      .on(t.embeddingStatus)
      .where(sql`embedding_status IN ('pending','stale')`),
    index("notes_project_updated_idx")
      .on(t.projectId, t.updatedAt)
      .where(sql`deleted_at IS NULL`),
    check(
      "notes_visibility_check",
      sql`${t.visibility} IN ('private', 'team')`,
    ),
    check(
      "notes_type_check",
      sql`${t.type} IN ('reference', 'guidance', 'knowledge')`,
    ),
    check(
      "notes_feed_mode_check",
      sql`${t.feedMode} IN ('none', 'all', 'categories', 'tags', 'tasks')`,
    ),
    check(
      "notes_embedding_status_check",
      sql`${t.embeddingStatus} IN ('none', 'pending', 'ready', 'failed', 'stale')`,
    ),
    check(
      "notes_title_len_check",
      sql`octet_length(${t.title}) <= ${sqlInt(NOTE_TITLE_MAX_BYTES)}`,
    ),
    check(
      "notes_slug_len_check",
      sql`octet_length(${t.slug}) <= ${sqlInt(NOTE_TITLE_MAX_BYTES)}`,
    ),
    // The generated search_tsv left()-bounds its own input (see
    // NOTE_SEARCH_INDEXED_CHARS), so this CHECK is the call-surface contract
    // for body size, not the tsvector overflow guard.
    check(
      "notes_body_len_check",
      sql`char_length(${t.body}) <= ${sqlInt(NOTE_BODY_MAX_CHARS)}`,
    ),
  ],
).enableRLS();

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;

// ---------------------------------------------------------------------------
// Note Folders (markers for explicitly created empty folders)
// ---------------------------------------------------------------------------

// Pure marker rows: the notes tree stays path-derived from live notes'
// `folder` values; these rows only add explicitly created folders that
// hold no notes yet, so they survive reloads. Ancestors are never stored
// (the client derives them), and `moveFolder` rewrites rows here as
// delete-then-insert so the folders-list validator (MAX(created_at),
// COUNT(*)) shifts on every mutation.
export const noteFolders = pgTable(
  "note_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    createdBy: uuid("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("note_folders_project_path_unique").on(t.projectId, t.path),
  ],
).enableRLS();

export type NoteFolder = typeof noteFolders.$inferSelect;
export type NewNoteFolder = typeof noteFolders.$inferInsert;

// ---------------------------------------------------------------------------
// Note ↔ Task Links (junction: notes reference tasks)
// ---------------------------------------------------------------------------

export const noteTaskLinks = pgTable(
  "note_task_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").$type<NoteTaskLinkKind>().notNull().default("mention"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("note_task_links_task_id_idx").on(t.taskId),
    unique("note_task_links_note_task_kind_unique").on(
      t.noteId,
      t.taskId,
      t.kind,
    ),
    check(
      "note_task_links_kind_check",
      sql`${t.kind} IN ('mention', 'reference', 'spec_of')`,
    ),
  ],
).enableRLS();

export type NoteTaskLink = typeof noteTaskLinks.$inferSelect;
export type NewNoteTaskLink = typeof noteTaskLinks.$inferInsert;

// ---------------------------------------------------------------------------
// Note ↔ Note Links ([[wiki]]-style cross-references between notes)
// ---------------------------------------------------------------------------

export const noteLinks = pgTable(
  "note_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceNoteId: uuid("source_note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    targetNoteId: uuid("target_note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("note_links_target_idx").on(t.targetNoteId),
    unique("note_links_source_target_unique").on(
      t.sourceNoteId,
      t.targetNoteId,
    ),
    check("note_links_no_self", sql`${t.sourceNoteId} <> ${t.targetNoteId}`),
  ],
).enableRLS();

export type NoteLink = typeof noteLinks.$inferSelect;
export type NewNoteLink = typeof noteLinks.$inferInsert;

// ---------------------------------------------------------------------------
// Note Revisions (append-only body/title history for rollback + audit)
// ---------------------------------------------------------------------------

export const noteRevisions = pgTable(
  "note_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdBy: uuid("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("note_revisions_note_version_unique").on(t.noteId, t.version),
    // A revision snapshots a note's body/title, so it shares the source caps
    // (NOTE_BODY_MAX_CHARS / NOTE_TITLE_MAX_BYTES). Bounds the append-only
    // trail so a member cannot write a multi-hundred-MB revision under RLS.
    check(
      "note_revisions_body_len_check",
      sql`char_length(${t.body}) <= ${sqlInt(NOTE_BODY_MAX_CHARS)}`,
    ),
    check(
      "note_revisions_title_len_check",
      sql`octet_length(${t.title}) <= ${sqlInt(NOTE_TITLE_MAX_BYTES)}`,
    ),
  ],
).enableRLS();

export type NoteRevision = typeof noteRevisions.$inferSelect;
export type NewNoteRevision = typeof noteRevisions.$inferInsert;

// ---------------------------------------------------------------------------
// Legal Acceptances
// ---------------------------------------------------------------------------

/** Longest storable client IP; IPv6 maxes at 45 chars, margin for zone ids. */
export const LEGAL_IP_MAX_CHARS = 64;

/** Cap for the attacker-controlled User-Agent header stored as evidence. */
export const LEGAL_USER_AGENT_MAX_CHARS = 1024;

export const legalAcceptances = pgTable(
  "legal_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Which organization entered the agreement; set for org-scoped documents
    // (dpa), null for personal ones (terms, privacy). "set null" keeps the
    // row as contract evidence when the organization is deleted.
    organizationId: uuid("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    documentType: text("document_type").$type<LegalDocumentType>().notNull(),
    documentVersion: text("document_version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => [
    check(
      "legal_acceptances_document_type_check",
      sql`${t.documentType} IN ('terms', 'privacy', 'dpa')`,
    ),
    // Both values are client-controlled request metadata landing in a
    // permanent evidence table; recordAcceptance truncates before insert and
    // these checks are the backstop.
    check(
      "legal_acceptances_ip_len_check",
      sql`char_length(${t.ipAddress}) <= ${sqlInt(LEGAL_IP_MAX_CHARS)}`,
    ),
    check(
      "legal_acceptances_user_agent_len_check",
      sql`char_length(${t.userAgent}) <= ${sqlInt(LEGAL_USER_AGENT_MAX_CHARS)}`,
    ),
  ],
).enableRLS();

export type LegalAcceptance = typeof legalAcceptances.$inferSelect;
export type NewLegalAcceptance = typeof legalAcceptances.$inferInsert;

// ---------------------------------------------------------------------------
// Team Invite Codes (separate file, re-exported here for drizzle-kit)
// ---------------------------------------------------------------------------

export * from "./team-schema";
