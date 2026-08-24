/** Versioned organization workspace archive validation and serialization. */

import { z } from "zod/v4";
import {
  NOTE_BODY_MAX_CHARS,
  NOTE_FOLDER_MAX_CHARS,
  NOTE_TITLE_MAX_BYTES,
} from "@/lib/db/schema";
import {
  RESERVED_SLUGS,
  SLUG_MAX,
  SLUG_MIN,
  SLUG_PATTERN,
  TEAM_NAME_MAX,
} from "@/lib/team/slug-rules";
import { PROJECT_STATUS_ORDER, TASK_STATUSES } from "@/lib/types";
import { MAX_ORGANIZATION_ARCHIVE_BYTES } from "@/lib/organization-portability/client";

export {
  MAX_ORGANIZATION_ARCHIVE_BYTES,
  ORGANIZATION_ARCHIVE_MEDIA_TYPE,
  organizationArchiveFilename,
} from "@/lib/organization-portability/client";

/** Maximum total number of workspace rows accepted in one archive. */
export const MAX_ORGANIZATION_ARCHIVE_ROWS = 500_000;

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

const timestampSchema = z.iso.datetime({ offset: true });
const nullableTimestampSchema = timestampSchema.nullable();
const sourceIdSchema = z.uuid();
const actorSchema = z.enum(["exporter"]).nullable();
const stringArraySchema = z.array(z.string());
const metadataSchema = z.record(z.string(), z.unknown()).nullable();
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();

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

const projectSchema = z.strictObject({
  sourceId: sourceIdSchema,
  title: z.string(),
  identifier: z.string(),
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
  order: z.number().int(),
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
  kind: z.string(),
  url: z.string(),
  label: z.string().nullable(),
  createdAt: timestampSchema,
  createdBy: actorSchema,
  metadata: metadataSchema,
});

const activityEventSchema = z.strictObject({
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
});

const noteSchema = z.strictObject({
  sourceId: sourceIdSchema,
  projectSourceId: sourceIdSchema,
  sequenceNumber: positiveIntegerSchema,
  type: z.enum(["reference", "guidance", "knowledge"]),
  folder: z.string().max(NOTE_FOLDER_MAX_CHARS),
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
  embeddingStatus: z.enum(["none", "pending", "ready", "failed", "stale"]),
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
  path: z.string().max(NOTE_FOLDER_MAX_CHARS),
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
    name: z.string().trim().min(1).max(TEAM_NAME_MAX),
    slug: z
      .string()
      .min(SLUG_MIN)
      .max(SLUG_MAX)
      .regex(SLUG_PATTERN)
      .refine((slug) => !RESERVED_SLUGS.has(slug)),
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

/** Validated version-1 organization workspace archive. */
export type OrganizationArchive = z.infer<typeof organizationArchiveSchema>;

/** Error raised when an organization archive is malformed or too large. */
export class OrganizationArchiveError extends Error {
  /**
   * Create a client-safe archive validation error.
   *
   * @param message - Safe failure description.
   */
  constructor(message: string) {
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
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.sourceId)) {
      throw new OrganizationArchiveError(
        `${collectionName} contains duplicate sourceId`,
      );
    }
    ids.add(row.sourceId);
  }
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
    if (source.projectSourceId !== target.projectSourceId) {
      throw new OrganizationArchiveError(
        `taskEdges[${index}] crosses project boundaries`,
      );
    }
  });
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
    );
  }
  const parsed = organizationArchiveSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrganizationArchiveError("Archive does not match version 1");
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
 * Validate and serialize an organization archive.
 *
 * @param archive - Archive to validate and encode as JSON text.
 * @returns Compact JSON serialization.
 * @throws {OrganizationArchiveError} When validation fails or output is too large.
 */
export function serializeOrganizationArchive(
  archive: OrganizationArchive,
): string {
  const serialized = JSON.stringify(parseOrganizationArchive(archive));
  if (utf8ByteLength(serialized) > MAX_ORGANIZATION_ARCHIVE_BYTES) {
    throw new OrganizationArchiveError(
      `Archive exceeds ${MAX_ORGANIZATION_ARCHIVE_BYTES} bytes`,
    );
  }
  return serialized;
}
