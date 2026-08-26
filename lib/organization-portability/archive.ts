/** Versioned organization workspace archive validation and serialization. */

import { z } from "zod/v4";
import {
  NOTE_BODY_MAX_CHARS,
  NOTE_FOLDER_MAX_CHARS,
  NOTE_TITLE_MAX_BYTES,
} from "@/lib/db/schema";
import { identifierSchema } from "@/lib/graph/identifier";
import { LINK_KINDS } from "@/lib/links/classify";
import { PROJECT_STATUS_ORDER, TASK_STATUSES } from "@/lib/types";
import { MAX_ORGANIZATION_ARCHIVE_BYTES } from "@/lib/organization-portability/client";

export {
  MAX_ORGANIZATION_ARCHIVE_BYTES,
  MAX_ORGANIZATION_ARCHIVE_MIB,
  MAX_ORGANIZATION_IMPORT_BYTES,
  MAX_ORGANIZATION_IMPORT_MIB,
  ORGANIZATION_EXPORT_COOLDOWN_DAYS,
  ORGANIZATION_EXPORT_INTENT_HEADER,
  ORGANIZATION_EXPORT_INTENT_VALUE,
  ORGANIZATION_ARCHIVE_MEDIA_TYPE,
  organizationArchiveFilename,
} from "@/lib/organization-portability/client";

/** Maximum total number of workspace rows accepted in one archive. */
export const MAX_ORGANIZATION_ARCHIVE_ROWS = 50_000;

const MAX_ARCHIVE_STRING_ARRAY_ITEMS = 5_000;
const MAX_ARCHIVE_METADATA_KEYS = 1_000;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

const archiveCollectionNames = [
  "projects",
  "tasks",
  "taskEdges",
  "taskAssignments",
  "taskAcceptanceCriteria",
  "taskDecisions",
  "taskLinks",
  "activityEvents",
  "notes",
  "noteFolders",
  "noteTaskLinks",
  "noteFeedTasks",
  "noteLinks",
  "noteRevisions",
] as const;

/** Array-valued collection names in a version-1 organization archive. */
export type OrganizationArchiveCollectionName =
  (typeof archiveCollectionNames)[number];

const timestampSchema = z.iso.datetime({ offset: true });
const nullableTimestampSchema = timestampSchema.nullable();
const sourceIdSchema = z.uuid();
const actorSchema = z.enum(["exporter"]).nullable();
const stringArraySchema = z
  .array(z.string())
  .max(MAX_ARCHIVE_STRING_ARRAY_ITEMS);
const metadataSchema = z
  .record(z.string(), z.unknown())
  .nullable()
  .refine(
    (value) =>
      value === null || Object.keys(value).length <= MAX_ARCHIVE_METADATA_KEYS,
  );
const postgresIntegerSchema = z
  .number()
  .int()
  .min(-POSTGRES_INTEGER_MAX - 1)
  .max(POSTGRES_INTEGER_MAX);
const nonnegativeIntegerSchema = postgresIntegerSchema.nonnegative();
const positiveIntegerSchema = postgresIntegerSchema.positive();

/**
 * Measure a string's UTF-8 byte length.
 *
 * @param value - String to encode.
 * @returns Encoded byte count.
 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const indexedTextSchema = z
  .string()
  .refine((value) => utf8ByteLength(value) <= NOTE_TITLE_MAX_BYTES);

// Mirrors the `IS NFC NORMALIZED` CHECKs on notes.folder and note_folders.path.
const nfcFolderPathSchema = z
  .string()
  .max(NOTE_FOLDER_MAX_CHARS)
  .refine((value) => value === value.normalize("NFC"));

const projectSchema = z.strictObject({
  sourceId: sourceIdSchema,
  title: z.string(),
  identifier: identifierSchema,
  description: z.string(),
  status: z.enum(PROJECT_STATUS_ORDER),
  categories: stringArraySchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  metaUpdatedAt: timestampSchema,
});

const taskSchema = z.strictObject({
  sourceId: sourceIdSchema,
  projectSourceId: sourceIdSchema,
  title: z.string(),
  sequenceNumber: positiveIntegerSchema,
  description: z.string(),
  status: z.enum(TASK_STATUSES),
  order: postgresIntegerSchema,
  category: z.string().nullable(),
  implementationPlan: z.string().nullable(),
  executionRecord: z.string().nullable(),
  tags: stringArraySchema,
  priority: z.enum(["urgent", "core", "normal", "backlog"]).nullable(),
  estimate: z
    .union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(5),
      z.literal(8),
      z.literal(13),
    ])
    .nullable(),
  files: stringArraySchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  metaUpdatedAt: timestampSchema,
});

const taskEdgeSchema = z.strictObject({
  sourceId: sourceIdSchema,
  sourceTaskSourceId: sourceIdSchema,
  targetTaskSourceId: sourceIdSchema,
  edgeType: z.enum(["depends_on", "relates_to"]),
  note: z.string(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  metaUpdatedAt: timestampSchema,
});

const taskAssignmentSchema = z.strictObject({
  taskSourceId: sourceIdSchema,
  createdAt: timestampSchema,
});

const taskAcceptanceCriterionSchema = z.strictObject({
  sourceId: sourceIdSchema,
  taskSourceId: sourceIdSchema,
  text: z.string(),
  checked: z.boolean(),
  position: nonnegativeIntegerSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const taskDecisionSchema = z.strictObject({
  sourceId: sourceIdSchema,
  taskSourceId: sourceIdSchema,
  text: z.string(),
  source: z.enum(["brainstorm", "refinement", "planning", "execution"]),
  decisionDate: z.iso.date(),
  position: nonnegativeIntegerSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const taskLinkSchema = z.strictObject({
  sourceId: sourceIdSchema,
  taskSourceId: sourceIdSchema,
  kind: z.enum(LINK_KINDS),
  // Every other writer of task_links.url funnels through classifyLink, whose
  // http/https protocol gate is the chokepoint preventing click-to-exec XSS
  // (lib/links/classify.ts). Imported archives must clear the same gate: the
  // UI renders these urls as raw hrefs.
  url: z.string().refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }),
  label: z.string().nullable(),
  createdAt: timestampSchema,
  createdBy: actorSchema,
});

const activityEventSchema = z
  .strictObject({
    sourceId: sourceIdSchema,
    projectSourceId: sourceIdSchema,
    taskSourceId: sourceIdSchema.nullable(),
    noteSourceId: sourceIdSchema.nullable(),
    type: z.enum([
      "task_created",
      "title_changed",
      "description_changed",
      "status_changed",
      "priority_changed",
      "estimate_changed",
      "category_changed",
      "moved",
      "tag_added",
      "tag_removed",
      "plan_set",
      "record_set",
      "files_changed",
      "assignee_added",
      "assignee_removed",
      "criterion_added",
      "criterion_removed",
      "criterion_edited",
      "criterion_checked",
      "criterion_unchecked",
      "decision_added",
      "decision_removed",
      "decision_edited",
      "link_added",
      "link_removed",
      "link_updated",
      "edge_added",
      "edge_removed",
      "edge_updated",
      "project_created",
      "note_created",
      "note_updated",
      "note_moved",
      "note_deleted",
      "note_restored",
    ]),
    createdAt: timestampSchema,
    actor: actorSchema,
    source: z.enum(["web", "mcp", "system"]),
    summary: z.string(),
    targetRef: z.string().nullable(),
    metadata: metadataSchema,
    // Mirrors the activity_events_note_ref_check CHECK: note_* events must
    // name their note.
  })
  .refine(
    (event) => !event.type.startsWith("note_") || event.noteSourceId !== null,
  );

const noteSchema = z.strictObject({
  sourceId: sourceIdSchema,
  projectSourceId: sourceIdSchema,
  sequenceNumber: positiveIntegerSchema,
  type: z.enum(["reference", "guidance", "knowledge"]),
  folder: nfcFolderPathSchema,
  title: indexedTextSchema,
  slug: indexedTextSchema,
  summary: z.string().max(1000),
  body: z.string().max(NOTE_BODY_MAX_CHARS),
  visibility: z.enum(["private", "team"]),
  sharedSince: nullableTimestampSchema,
  agentWritable: z.boolean(),
  locked: z.boolean(),
  feedMode: z.enum(["none", "all", "categories", "tags", "tasks"]),
  feedCategories: stringArraySchema,
  feedTags: stringArraySchema,
  tags: stringArraySchema,
  category: z.string().nullable(),
  version: positiveIntegerSchema,
  shareRequestedBy: actorSchema,
  createdBy: actorSchema,
  updatedBy: actorSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  metaUpdatedAt: timestampSchema,
  deletedAt: nullableTimestampSchema,
});

const noteFolderSchema = z.strictObject({
  sourceId: sourceIdSchema,
  projectSourceId: sourceIdSchema,
  path: nfcFolderPathSchema,
  createdAt: timestampSchema,
});

const noteTaskLinkSchema = z.strictObject({
  sourceId: sourceIdSchema,
  noteSourceId: sourceIdSchema,
  taskSourceId: sourceIdSchema,
  kind: z.enum(["mention", "reference", "spec_of"]),
  createdAt: timestampSchema,
});

const noteFeedTaskSchema = z.strictObject({
  sourceId: sourceIdSchema,
  noteSourceId: sourceIdSchema,
  taskSourceId: sourceIdSchema,
  createdAt: timestampSchema,
});

const noteLinkSchema = z.strictObject({
  sourceId: sourceIdSchema,
  sourceNoteSourceId: sourceIdSchema,
  targetNoteSourceId: sourceIdSchema,
  createdAt: timestampSchema,
});

const noteRevisionSchema = z.strictObject({
  sourceId: sourceIdSchema,
  noteSourceId: sourceIdSchema,
  version: positiveIntegerSchema,
  title: indexedTextSchema,
  body: z.string().max(NOTE_BODY_MAX_CHARS),
  createdBy: actorSchema,
  createdAt: timestampSchema,
});

const organizationArchiveSchema = z.strictObject({
  format: z.literal("piyaz-organization"),
  version: z.literal(1),
  exportedAt: timestampSchema,
  organization: z.strictObject({
    name: z.string(),
    slug: z.string(),
  }),
  projects: z.array(projectSchema),
  tasks: z.array(taskSchema),
  taskEdges: z.array(taskEdgeSchema),
  taskAssignments: z.array(taskAssignmentSchema),
  taskAcceptanceCriteria: z.array(taskAcceptanceCriterionSchema),
  taskDecisions: z.array(taskDecisionSchema),
  taskLinks: z.array(taskLinkSchema),
  activityEvents: z.array(activityEventSchema),
  notes: z.array(noteSchema),
  noteFolders: z.array(noteFolderSchema),
  noteTaskLinks: z.array(noteTaskLinkSchema),
  noteFeedTasks: z.array(noteFeedTaskSchema),
  noteLinks: z.array(noteLinkSchema),
  noteRevisions: z.array(noteRevisionSchema),
});

const organizationArchiveRowSchemas = {
  projects: projectSchema,
  tasks: taskSchema,
  taskEdges: taskEdgeSchema,
  taskAssignments: taskAssignmentSchema,
  taskAcceptanceCriteria: taskAcceptanceCriterionSchema,
  taskDecisions: taskDecisionSchema,
  taskLinks: taskLinkSchema,
  activityEvents: activityEventSchema,
  notes: noteSchema,
  noteFolders: noteFolderSchema,
  noteTaskLinks: noteTaskLinkSchema,
  noteFeedTasks: noteFeedTaskSchema,
  noteLinks: noteLinkSchema,
  noteRevisions: noteRevisionSchema,
} as const;

/** Validated version-1 organization workspace archive. */
export type OrganizationArchive = z.infer<typeof organizationArchiveSchema>;

/** One row from a named organization archive collection. */
export type OrganizationArchiveRow<
  TName extends OrganizationArchiveCollectionName,
> = OrganizationArchive[TName][number];

/** Error raised when an organization archive is malformed or too large. */
export class OrganizationArchiveError extends Error {
  /**
   * Create a client-safe archive validation error.
   *
   * @param message - Safe failure description.
   * @param code - Route-level failure category.
   */
  constructor(
    message: string,
    public readonly code:
      | "invalid_archive"
      | "archive_too_large" = "invalid_archive",
  ) {
    super(message);
    this.name = "OrganizationArchiveError";
  }
}

/**
 * Count archive rows without traversing or validating their contents.
 *
 * @param value - Untrusted decoded JSON value.
 * @returns Total array length across recognized row collections.
 */
function archiveRowCount(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  const record = value as Record<string, unknown>;
  return archiveCollectionNames.reduce((total, name) => {
    const collection = record[name];
    return total + (Array.isArray(collection) ? collection.length : 0);
  }, 0);
}

/**
 * Reject duplicate source ids within a row collection.
 *
 * @param collectionName - Archive collection label used in errors.
 * @param rows - Rows carrying archive-local source ids.
 * @throws {OrganizationArchiveError} When a source id occurs twice.
 */
function assertUniqueSourceIds(
  collectionName: string,
  rows: readonly { sourceId: string }[],
): void {
  assertUniqueRows(collectionName, rows, "sourceId", (row) => [row.sourceId]);
}

/**
 * Reject rows that collide on a destination-unique key.
 *
 * @param collectionName - Archive collection label used in errors.
 * @param rows - Rows of one archive collection.
 * @param constraint - Key description used in errors.
 * @param keyOf - Destination-unique key parts, or null to skip the row.
 * @throws {OrganizationArchiveError} When two rows share a key.
 */
function assertUniqueRows<T>(
  collectionName: string,
  rows: readonly T[],
  constraint: string,
  keyOf: (row: T) => readonly (string | number)[] | null,
): void {
  const keys = new Set<string>();
  for (const row of rows) {
    const parts = keyOf(row);
    if (parts === null) continue;
    const key = parts.join("\u0000");
    if (keys.has(key)) {
      throw new OrganizationArchiveError(
        `${collectionName} contains duplicate ${constraint}`,
      );
    }
    keys.add(key);
  }
}

/**
 * Reject archives that would violate destination-table unique constraints.
 *
 * Import rewrites every source id, so `assertUniqueSourceIds` alone cannot
 * catch these: each check below mirrors one unique constraint or index in
 * lib/db/schema.ts that the insert would otherwise hit as a 500 after the
 * destination organization was already created.
 *
 * @param archive - Structurally valid archive.
 * @throws {OrganizationArchiveError} When a collision is present.
 */
function validateDestinationUniqueness(archive: OrganizationArchive): void {
  assertUniqueRows("projects", archive.projects, "identifier", (row) => [
    row.identifier,
  ]);
  assertUniqueRows("tasks", archive.tasks, "project sequenceNumber", (row) => [
    row.projectSourceId,
    row.sequenceNumber,
  ]);
  assertUniqueRows(
    "taskEdges",
    archive.taskEdges,
    "source, target, and edgeType",
    (row) => [row.sourceTaskSourceId, row.targetTaskSourceId, row.edgeType],
  );
  // task_assignees' primary key is (taskId, userId) and every imported
  // assignment lands on the importing user.
  assertUniqueRows(
    "taskAssignments",
    archive.taskAssignments,
    "taskSourceId",
    (row) => [row.taskSourceId],
  );
  assertUniqueRows(
    "taskAcceptanceCriteria",
    archive.taskAcceptanceCriteria,
    "task text",
    (row) => [row.taskSourceId, row.text],
  );
  assertUniqueRows(
    "taskDecisions",
    archive.taskDecisions,
    "task text",
    (row) => [row.taskSourceId, row.text],
  );
  assertUniqueRows("taskLinks", archive.taskLinks, "task url", (row) => [
    row.taskSourceId,
    row.url,
  ]);
  assertUniqueRows("notes", archive.notes, "project sequenceNumber", (row) => [
    row.projectSourceId,
    row.sequenceNumber,
  ]);
  // notes_project_slug_unique only covers live notes (deleted_at IS NULL).
  assertUniqueRows("notes", archive.notes, "project slug", (row) =>
    row.deletedAt === null ? [row.projectSourceId, row.slug] : null,
  );
  assertUniqueRows(
    "noteFolders",
    archive.noteFolders,
    "project path",
    (row) => [row.projectSourceId, row.path],
  );
  assertUniqueRows(
    "noteTaskLinks",
    archive.noteTaskLinks,
    "note, task, and kind",
    (row) => [row.noteSourceId, row.taskSourceId, row.kind],
  );
  assertUniqueRows(
    "noteFeedTasks",
    archive.noteFeedTasks,
    "note and task",
    (row) => [row.noteSourceId, row.taskSourceId],
  );
  assertUniqueRows(
    "noteLinks",
    archive.noteLinks,
    "source and target",
    (row) => [row.sourceNoteSourceId, row.targetNoteSourceId],
  );
  assertUniqueRows(
    "noteRevisions",
    archive.noteRevisions,
    "note version",
    (row) => [row.noteSourceId, row.version],
  );
}

/**
 * Resolve a referenced task or raise a stable validation error.
 *
 * @param tasksById - Valid task rows indexed by source id.
 * @param sourceId - Referenced task source id.
 * @param path - Archive field path used in errors.
 * @returns The referenced task row.
 * @throws {OrganizationArchiveError} When the task is absent.
 */
function requireTask(
  tasksById: ReadonlyMap<string, OrganizationArchive["tasks"][number]>,
  sourceId: string,
  path: string,
): OrganizationArchive["tasks"][number] {
  const task = tasksById.get(sourceId);
  if (!task) {
    throw new OrganizationArchiveError(
      `${path} does not reference an exported task`,
    );
  }
  return task;
}

/**
 * Resolve a referenced note or raise a stable validation error.
 *
 * @param notesById - Valid note rows indexed by source id.
 * @param sourceId - Referenced note source id.
 * @param path - Archive field path used in errors.
 * @returns The referenced note row.
 * @throws {OrganizationArchiveError} When the note is absent.
 */
function requireNote(
  notesById: ReadonlyMap<string, OrganizationArchive["notes"][number]>,
  sourceId: string,
  path: string,
): OrganizationArchive["notes"][number] {
  const note = notesById.get(sourceId);
  if (!note) {
    throw new OrganizationArchiveError(
      `${path} does not reference an exported note`,
    );
  }
  return note;
}

/**
 * Reject cycles in the imported dependency subgraph.
 *
 * @param archive - Structurally valid archive with resolved edge endpoints.
 * @throws {OrganizationArchiveError} When `depends_on` edges form a cycle.
 */
function validateDependencyAcyclicity(archive: OrganizationArchive): void {
  const outgoing = new Map(
    archive.tasks.map((task) => [task.sourceId, [] as string[]]),
  );
  const indegree = new Map(archive.tasks.map((task) => [task.sourceId, 0]));
  for (const edge of archive.taskEdges) {
    if (edge.edgeType !== "depends_on") continue;
    outgoing.get(edge.sourceTaskSourceId)?.push(edge.targetTaskSourceId);
    indegree.set(
      edge.targetTaskSourceId,
      (indegree.get(edge.targetTaskSourceId) ?? 0) + 1,
    );
  }
  const queue = [...indegree].filter(([, count]) => count === 0);
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const [taskId] = queue[index];
    visited += 1;
    for (const targetId of outgoing.get(taskId) ?? []) {
      const count = (indegree.get(targetId) ?? 0) - 1;
      indegree.set(targetId, count);
      if (count === 0) queue.push([targetId, count]);
    }
  }
  if (visited !== archive.tasks.length) {
    throw new OrganizationArchiveError("taskEdges contains a depends_on cycle");
  }
}

/**
 * Validate archive-local references and project boundaries.
 *
 * @param archive - Structurally valid archive.
 * @throws {OrganizationArchiveError} When a reference is invalid.
 */
function validateArchiveReferences(archive: OrganizationArchive): void {
  const projectIds = new Set(archive.projects.map((row) => row.sourceId));
  const tasksById = new Map(archive.tasks.map((row) => [row.sourceId, row]));
  const notesById = new Map(archive.notes.map((row) => [row.sourceId, row]));

  archive.tasks.forEach((row, index) => {
    if (!projectIds.has(row.projectSourceId)) {
      throw new OrganizationArchiveError(
        `tasks[${index}].projectSourceId does not reference an exported project`,
      );
    }
  });
  archive.taskEdges.forEach((row, index) => {
    const source = requireTask(
      tasksById,
      row.sourceTaskSourceId,
      `taskEdges[${index}].sourceTaskSourceId`,
    );
    const target = requireTask(
      tasksById,
      row.targetTaskSourceId,
      `taskEdges[${index}].targetTaskSourceId`,
    );
    if (source.sourceId === target.sourceId) {
      throw new OrganizationArchiveError(
        `taskEdges[${index}] links a task to itself`,
      );
    }
    if (source.projectSourceId !== target.projectSourceId) {
      throw new OrganizationArchiveError(
        `taskEdges[${index}] crosses project boundaries`,
      );
    }
  });
  validateDependencyAcyclicity(archive);
  archive.taskAssignments.forEach((row, index) => {
    requireTask(
      tasksById,
      row.taskSourceId,
      `taskAssignments[${index}].taskSourceId`,
    );
  });
  archive.taskAcceptanceCriteria.forEach((row, index) => {
    requireTask(
      tasksById,
      row.taskSourceId,
      `taskAcceptanceCriteria[${index}].taskSourceId`,
    );
  });
  archive.taskDecisions.forEach((row, index) => {
    requireTask(
      tasksById,
      row.taskSourceId,
      `taskDecisions[${index}].taskSourceId`,
    );
  });
  archive.taskLinks.forEach((row, index) => {
    requireTask(
      tasksById,
      row.taskSourceId,
      `taskLinks[${index}].taskSourceId`,
    );
  });
  archive.notes.forEach((row, index) => {
    if (!projectIds.has(row.projectSourceId)) {
      throw new OrganizationArchiveError(
        `notes[${index}].projectSourceId does not reference an exported project`,
      );
    }
  });
  archive.noteFolders.forEach((row, index) => {
    if (!projectIds.has(row.projectSourceId)) {
      throw new OrganizationArchiveError(
        `noteFolders[${index}].projectSourceId does not reference an exported project`,
      );
    }
  });
  archive.noteTaskLinks.forEach((row, index) => {
    const note = requireNote(
      notesById,
      row.noteSourceId,
      `noteTaskLinks[${index}].noteSourceId`,
    );
    const task = requireTask(
      tasksById,
      row.taskSourceId,
      `noteTaskLinks[${index}].taskSourceId`,
    );
    if (note.projectSourceId !== task.projectSourceId) {
      throw new OrganizationArchiveError(
        `noteTaskLinks[${index}] crosses project boundaries`,
      );
    }
  });
  archive.noteFeedTasks.forEach((row, index) => {
    const note = requireNote(
      notesById,
      row.noteSourceId,
      `noteFeedTasks[${index}].noteSourceId`,
    );
    const task = requireTask(
      tasksById,
      row.taskSourceId,
      `noteFeedTasks[${index}].taskSourceId`,
    );
    if (note.projectSourceId !== task.projectSourceId) {
      throw new OrganizationArchiveError(
        `noteFeedTasks[${index}] crosses project boundaries`,
      );
    }
  });
  archive.noteLinks.forEach((row, index) => {
    const source = requireNote(
      notesById,
      row.sourceNoteSourceId,
      `noteLinks[${index}].sourceNoteSourceId`,
    );
    const target = requireNote(
      notesById,
      row.targetNoteSourceId,
      `noteLinks[${index}].targetNoteSourceId`,
    );
    if (source.sourceId === target.sourceId) {
      throw new OrganizationArchiveError(
        `noteLinks[${index}] links a note to itself`,
      );
    }
    if (source.projectSourceId !== target.projectSourceId) {
      throw new OrganizationArchiveError(
        `noteLinks[${index}] crosses project boundaries`,
      );
    }
  });
  archive.noteRevisions.forEach((row, index) => {
    requireNote(
      notesById,
      row.noteSourceId,
      `noteRevisions[${index}].noteSourceId`,
    );
  });
  archive.activityEvents.forEach((row, index) => {
    if (!projectIds.has(row.projectSourceId)) {
      throw new OrganizationArchiveError(
        `activityEvents[${index}].projectSourceId does not reference an exported project`,
      );
    }
    if (row.taskSourceId) {
      const task = requireTask(
        tasksById,
        row.taskSourceId,
        `activityEvents[${index}].taskSourceId`,
      );
      if (task.projectSourceId !== row.projectSourceId) {
        throw new OrganizationArchiveError(
          `activityEvents[${index}] crosses project boundaries`,
        );
      }
    }
    if (row.noteSourceId) {
      const note = requireNote(
        notesById,
        row.noteSourceId,
        `activityEvents[${index}].noteSourceId`,
      );
      if (note.projectSourceId !== row.projectSourceId) {
        throw new OrganizationArchiveError(
          `activityEvents[${index}] crosses project boundaries`,
        );
      }
    }
  });
}

/**
 * Parse and fully validate a decoded organization archive.
 *
 * @param value - Untrusted JSON value.
 * @returns Strictly validated version-1 archive.
 * @throws {OrganizationArchiveError} When the archive is invalid or too large.
 */
export function parseOrganizationArchive(value: unknown): OrganizationArchive {
  if (archiveRowCount(value) > MAX_ORGANIZATION_ARCHIVE_ROWS) {
    throw new OrganizationArchiveError(
      `Archive exceeds ${MAX_ORGANIZATION_ARCHIVE_ROWS} rows`,
      "archive_too_large",
    );
  }
  const parsed = organizationArchiveSchema.safeParse(value);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".");
    throw new OrganizationArchiveError(
      path
        ? `Archive does not match version 1 at ${path}`
        : "Archive does not match version 1",
    );
  }

  assertUniqueSourceIds("projects", parsed.data.projects);
  assertUniqueSourceIds("tasks", parsed.data.tasks);
  assertUniqueSourceIds("taskEdges", parsed.data.taskEdges);
  assertUniqueSourceIds(
    "taskAcceptanceCriteria",
    parsed.data.taskAcceptanceCriteria,
  );
  assertUniqueSourceIds("taskDecisions", parsed.data.taskDecisions);
  assertUniqueSourceIds("taskLinks", parsed.data.taskLinks);
  assertUniqueSourceIds("activityEvents", parsed.data.activityEvents);
  assertUniqueSourceIds("notes", parsed.data.notes);
  assertUniqueSourceIds("noteFolders", parsed.data.noteFolders);
  assertUniqueSourceIds("noteTaskLinks", parsed.data.noteTaskLinks);
  assertUniqueSourceIds("noteFeedTasks", parsed.data.noteFeedTasks);
  assertUniqueSourceIds("noteLinks", parsed.data.noteLinks);
  assertUniqueSourceIds("noteRevisions", parsed.data.noteRevisions);
  validateDestinationUniqueness(parsed.data);
  validateArchiveReferences(parsed.data);
  return parsed.data;
}

/**
 * Decode UTF-8 JSON bytes and validate an organization archive.
 *
 * @param bytes - Raw archive bytes.
 * @returns Strictly validated version-1 archive.
 * @throws {OrganizationArchiveError} When decoding, JSON parsing, or validation fails.
 */
export function decodeOrganizationArchive(
  bytes: Uint8Array,
): OrganizationArchive {
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseOrganizationArchive(JSON.parse(json));
  } catch (error) {
    if (error instanceof OrganizationArchiveError) throw error;
    throw new OrganizationArchiveError("Archive is not valid UTF-8 JSON");
  }
}

/**
 * Validate and serialize one archive row without cloning the full archive.
 *
 * @param collection - Archive collection receiving the row.
 * @param row - Typed row produced from one database result.
 * @returns Compact JSON for the validated row.
 * @throws {OrganizationArchiveError} When the row violates version 1.
 */
export function serializeOrganizationArchiveRow<
  TName extends OrganizationArchiveCollectionName,
>(collection: TName, row: OrganizationArchiveRow<TName>): string {
  const parsed = organizationArchiveRowSchemas[collection].safeParse(row);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".");
    throw new OrganizationArchiveError(
      path
        ? `Archive does not match version 1 at ${collection}.${path}`
        : `Archive does not match version 1 at ${collection}`,
    );
  }
  return JSON.stringify(parsed.data);
}

/**
 * Serialize an already-validated organization archive.
 *
 * Validation is the producer's job (`exportOrganizationWorkspace` returns a
 * parsed archive); re-parsing here would deep-clone the complete bounded
 * payload inside a memory-constrained isolate for no new guarantee.
 *
 * @param archive - Validated archive to encode as JSON text.
 * @returns Compact JSON serialization.
 * @throws {OrganizationArchiveError} When the output is too large.
 */
export function serializeOrganizationArchive(
  archive: OrganizationArchive,
): string {
  const serialized = JSON.stringify(archive);
  if (utf8ByteLength(serialized) > MAX_ORGANIZATION_ARCHIVE_BYTES) {
    throw new OrganizationArchiveError(
      `Archive exceeds ${MAX_ORGANIZATION_ARCHIVE_BYTES} bytes`,
      "archive_too_large",
    );
  }
  return serialized;
}
