/** RLS-scoped organization workspace export and restore operations. */

import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { parseMemberRoles } from "@/lib/auth/permissions";
import { normalizeExecuteResult, toDate } from "@/lib/db/raw";
import {
  organizationExportEstimateStmt,
  type OrganizationExportEstimateRow,
} from "@/lib/db/raw/estimate-organization-export";
import { restoreArchiveClocks } from "@/lib/db/raw/restore-archive-clocks";
import { withUserContext, withUserContextRead } from "@/lib/db/rls";
import {
  activityEvents,
  noteFeedTasks,
  noteFolders,
  noteLinks,
  noteRevisions,
  notes,
  noteTaskLinks,
  organizationExportLimits,
  projects,
  taskAcceptanceCriteria,
  taskAssignees,
  taskDecisions,
  taskEdges,
  taskLinks,
  tasks,
} from "@/lib/db/schema";
import {
  MAX_ORGANIZATION_ARCHIVE_BYTES,
  MAX_ORGANIZATION_ARCHIVE_ROWS,
  ORGANIZATION_EXPORT_COOLDOWN_DAYS,
  OrganizationArchiveError,
  parseOrganizationArchive,
  type OrganizationArchive,
} from "@/lib/organization-portability/archive";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSERT_BATCH_SIZE = 500;
const IMPORTED_ACTIVITY_SUMMARY_PREFIX = "[imported] ";
const MAX_PORTABLE_ACTIVITY_FIELDS = 5_000;
const PORTABLE_ACTIVITY_SCALAR_KEYS = ["from", "to"] as const;
const PORTABLE_ACTIVITY_STRING_KEYS = [
  "direction",
  "relation",
  "previousSlug",
  "kind",
] as const;
const PORTABLE_ACTIVITY_INTEGER_KEYS = [
  "version",
  "restoredFromVersion",
] as const;

type SourceRow = { sourceId: string };

type ArchiveIdMaps = {
  projects: ReadonlyMap<string, string>;
  tasks: ReadonlyMap<string, string>;
  taskEdges: ReadonlyMap<string, string>;
  criteria: ReadonlyMap<string, string>;
  decisions: ReadonlyMap<string, string>;
  taskLinks: ReadonlyMap<string, string>;
  activityEvents: ReadonlyMap<string, string>;
  notes: ReadonlyMap<string, string>;
  noteFolders: ReadonlyMap<string, string>;
  noteTaskLinks: ReadonlyMap<string, string>;
  noteFeedTasks: ReadonlyMap<string, string>;
  noteLinks: ReadonlyMap<string, string>;
  noteRevisions: ReadonlyMap<string, string>;
};

/** Counts returned after a workspace archive is restored. */
export type OrganizationImportSummary = {
  projectCount: number;
  taskCount: number;
  noteCount: number;
  activityEventCount: number;
};

/** Error returned for every unauthorized or unresolved organization export. */
export class OrganizationExportForbiddenError extends Error {
  /** Create a non-disclosing organization export error. */
  constructor() {
    super("Organization workspace export is forbidden");
    this.name = "OrganizationExportForbiddenError";
  }
}

/** Error returned when a user has already started an export in the cooldown. */
export class OrganizationExportLimitError extends Error {
  /**
   * Create a durable export-limit error.
   *
   * @param retryAfterSeconds - Whole seconds until another export may start.
   */
  constructor(public readonly retryAfterSeconds: number) {
    super("Organization workspace export limit reached");
    this.name = "OrganizationExportLimitError";
  }
}

type ExportOrganization = {
  name: string;
  slug: string;
};

/**
 * Verify ownership and atomically reserve the caller's rolling export slot.
 *
 * @param userId - Authenticated exporting user id.
 * @param organizationId - Organization whose workspace should be exported.
 * @returns Organization identity used in the archive header.
 * @throws {OrganizationExportForbiddenError} When the caller is not an owner.
 * @throws {OrganizationExportLimitError} When the rolling limit is active.
 */
async function reserveOrganizationExport(
  userId: string,
  organizationId: string,
): Promise<ExportOrganization> {
  return withUserContext(userId, async (tx) => {
    const [organization] = await tx
      .select({
        name: sql<string>`name`,
        slug: sql<string>`slug`,
        memberRole: sql<string>`member_role`,
      })
      .from(sql`public.current_user_orgs()`)
      .where(sql`org_id = ${organizationId}::uuid`)
      .limit(1);
    if (
      !organization ||
      !parseMemberRoles(organization.memberRole).includes("owner")
    ) {
      throw new OrganizationExportForbiddenError();
    }

    const reservations = await tx
      .insert(organizationExportLimits)
      .values({ userId, lastStartedAt: sql`clock_timestamp()` })
      .onConflictDoUpdate({
        target: organizationExportLimits.userId,
        set: { lastStartedAt: sql`clock_timestamp()` },
        setWhere: sql`${organizationExportLimits.lastStartedAt} <= clock_timestamp() - interval '${sql.raw(
          String(ORGANIZATION_EXPORT_COOLDOWN_DAYS),
        )} days'`,
      })
      .returning({ startedAt: organizationExportLimits.lastStartedAt });
    if (reservations.length === 0) {
      const [limit] = await tx
        .select({
          retryAfterSeconds: sql<number>`GREATEST(1, CEIL(EXTRACT(EPOCH FROM (${organizationExportLimits.lastStartedAt} + interval '${sql.raw(
            String(ORGANIZATION_EXPORT_COOLDOWN_DAYS),
          )} days' - clock_timestamp()))))::integer`,
        })
        .from(organizationExportLimits)
        .where(eq(organizationExportLimits.userId, userId));
      if (!limit) {
        throw new Error("Organization export reservation disappeared");
      }
      throw new OrganizationExportLimitError(limit.retryAfterSeconds);
    }

    return { name: organization.name, slug: organization.slug };
  });
}

/**
 * Reject a workspace before its complete row set crosses the Neon boundary.
 *
 * PostgreSQL serializes only portable columns for the estimate. The fixed
 * per-row allowance covers archive key renames and collection punctuation;
 * exact serialization remains the final backstop against estimate drift.
 *
 * @param userId - Authenticated exporting user id.
 * @param organizationId - Organization whose rows should be measured.
 * @returns Nothing when the workspace fits the portable bounds.
 * @throws {OrganizationArchiveError} When row or encoded-size bounds fail.
 */
async function assertOrganizationExportWithinBounds(
  userId: string,
  organizationId: string,
): Promise<void> {
  const [raw] = await withUserContextRead(userId, (read) => [
    organizationExportEstimateStmt(read, userId, organizationId),
  ]);
  const [estimate] = normalizeExecuteResult<OrganizationExportEstimateRow>(raw);
  if (!estimate) {
    throw new Error("Organization export estimate returned no row");
  }

  const rowCount = Number(estimate.row_count);
  if (rowCount > MAX_ORGANIZATION_ARCHIVE_ROWS) {
    throw new OrganizationArchiveError(
      `Archive exceeds ${MAX_ORGANIZATION_ARCHIVE_ROWS} rows`,
      "archive_too_large",
    );
  }
  if (Number(estimate.estimated_bytes) > MAX_ORGANIZATION_ARCHIVE_BYTES) {
    throw new OrganizationArchiveError(
      `Archive exceeds ${MAX_ORGANIZATION_ARCHIVE_BYTES} bytes`,
      "archive_too_large",
    );
  }
}

/**
 * Convert a database timestamp to archive ISO form.
 *
 * @param value - Timestamp returned by either database driver.
 * @returns Canonical ISO timestamp.
 */
function isoTimestamp(value: Date | string): string {
  return toDate(value).toISOString();
}

/**
 * Convert a nullable database timestamp to archive ISO form.
 *
 * @param value - Nullable timestamp returned by either database driver.
 * @returns Canonical ISO timestamp or null.
 */
function nullableIsoTimestamp(value: Date | string | null): string | null {
  return value === null ? null : isoTimestamp(value);
}

/**
 * Normalize a user id into archive-local attribution.
 *
 * @param sourceUserId - Source row's nullable user id.
 * @param exporterId - Authenticated exporting user id.
 * @returns `exporter` for the caller's rows and null otherwise.
 */
function attribution(
  sourceUserId: string | null,
  exporterId: string,
): "exporter" | null {
  return sourceUserId === exporterId ? "exporter" : null;
}

/**
 * Check whether a value is safe portable activity metadata.
 *
 * @param value - Candidate scalar value.
 * @returns True for JSON scalars used by activity field changes.
 */
function isPortableActivityScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * Reduce activity metadata to the fields produced by Piyaz event writers.
 *
 * @param value - JSONB metadata from the database or an imported archive.
 * @returns Allowlisted portable metadata, or null when no fields are portable.
 */
function portableActivityMetadata(
  value: unknown,
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const input = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of PORTABLE_ACTIVITY_SCALAR_KEYS) {
    if (isPortableActivityScalar(input[key])) result[key] = input[key];
  }
  for (const key of PORTABLE_ACTIVITY_STRING_KEYS) {
    if (typeof input[key] === "string") result[key] = input[key];
  }
  for (const key of PORTABLE_ACTIVITY_INTEGER_KEYS) {
    if (Number.isInteger(input[key])) result[key] = input[key];
  }
  if (
    Array.isArray(input.fields) &&
    input.fields.length <= MAX_PORTABLE_ACTIVITY_FIELDS &&
    input.fields.every((field) => typeof field === "string")
  ) {
    result.fields = input.fields;
  }

  const provenance = input.portabilityImport;
  if (
    provenance !== null &&
    typeof provenance === "object" &&
    !Array.isArray(provenance)
  ) {
    const original = provenance as Record<string, unknown>;
    const originalActor = original.originalActor;
    const originalSource = original.originalSource;
    if (
      (originalActor === null || originalActor === "exporter") &&
      (originalSource === "web" ||
        originalSource === "mcp" ||
        originalSource === "system")
    ) {
      result.portabilityImport = { originalActor, originalSource };
    }
  }

  return Object.keys(result).length === 0 ? null : result;
}

/**
 * Convert an archive timestamp into a database timestamp.
 *
 * @param value - Validated ISO timestamp.
 * @returns Date suitable for a Drizzle timestamp column.
 */
function archiveDate(value: string): Date {
  return new Date(value);
}

/**
 * Convert a nullable archive timestamp into a database timestamp.
 *
 * @param value - Nullable validated ISO timestamp.
 * @returns Date or null for a Drizzle timestamp column.
 */
function nullableArchiveDate(value: string | null): Date | null {
  return value === null ? null : archiveDate(value);
}

/**
 * Allocate fresh destination ids for source archive rows.
 *
 * @param rows - Archive rows carrying source ids.
 * @returns Source-to-destination UUID map.
 */
function createIdMap(rows: readonly SourceRow[]): ReadonlyMap<string, string> {
  return new Map(rows.map((row) => [row.sourceId, crypto.randomUUID()]));
}

/**
 * Allocate every source-id map before any database write begins.
 *
 * @param archive - Validated workspace archive.
 * @returns Fresh id maps for every source-id collection.
 */
function createArchiveIdMaps(archive: OrganizationArchive): ArchiveIdMaps {
  return {
    projects: createIdMap(archive.projects),
    tasks: createIdMap(archive.tasks),
    taskEdges: createIdMap(archive.taskEdges),
    criteria: createIdMap(archive.taskAcceptanceCriteria),
    decisions: createIdMap(archive.taskDecisions),
    taskLinks: createIdMap(archive.taskLinks),
    activityEvents: createIdMap(archive.activityEvents),
    notes: createIdMap(archive.notes),
    noteFolders: createIdMap(archive.noteFolders),
    noteTaskLinks: createIdMap(archive.noteTaskLinks),
    noteFeedTasks: createIdMap(archive.noteFeedTasks),
    noteLinks: createIdMap(archive.noteLinks),
    noteRevisions: createIdMap(archive.noteRevisions),
  };
}

/**
 * Resolve a previously allocated destination id.
 *
 * @param ids - Source-to-destination UUID map.
 * @param sourceId - Archive-local source id.
 * @param collection - Collection name used in invariant failures.
 * @returns Fresh destination UUID.
 * @throws {OrganizationArchiveError} When the validated graph is inconsistent.
 */
function mappedId(
  ids: ReadonlyMap<string, string>,
  sourceId: string,
  collection: string,
): string {
  const id = ids.get(sourceId);
  if (!id) {
    throw new OrganizationArchiveError(
      `${collection} reference was not allocated for import`,
    );
  }
  return id;
}

/**
 * Insert rows in bounded batches to stay below PostgreSQL bind limits.
 *
 * @param rows - Destination insert values.
 * @param insert - Batch insertion callback.
 * @returns Promise that resolves after every batch is inserted.
 */
async function insertBatches<T>(
  rows: readonly T[],
  insert: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
    await insert(rows.slice(index, index + INSERT_BATCH_SIZE));
  }
}

/**
 * Restore clock rows in bounded batches.
 *
 * @param rows - Fresh ids paired with archived clock values.
 * @param restore - Clock restoration callback.
 * @returns Promise that resolves after every batch is restored.
 */
async function restoreClockBatches<T>(
  rows: readonly T[],
  restore: (batch: T[]) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
    await restore(rows.slice(index, index + INSERT_BATCH_SIZE));
  }
}

/**
 * Map archive attribution into the importing user.
 *
 * @param actor - Archive-local attribution marker.
 * @param userId - Importing user id.
 * @returns Importer id for exporter attribution and null otherwise.
 */
function importedAttribution(
  actor: "exporter" | null,
  userId: string,
): string | null {
  return actor === "exporter" ? userId : null;
}

type ArchiveActivityEventType =
  OrganizationArchive["activityEvents"][number]["type"];

/**
 * What each event type's `targetRef` holds: an {@link ArchiveIdMaps} key to
 * remap a workspace-row UUID through, `verbatim` for portable values (tags,
 * link urls, note slugs, or always-null), or `dropped` for foreign user ids
 * the export already nulls. Typed over the archive enum so a new event type
 * fails compilation here until its targetRef is routed.
 */
const ACTIVITY_TARGET_REMAP = {
  task_created: "verbatim",
  title_changed: "verbatim",
  description_changed: "verbatim",
  status_changed: "verbatim",
  priority_changed: "verbatim",
  estimate_changed: "verbatim",
  category_changed: "verbatim",
  moved: "verbatim",
  tag_added: "verbatim",
  tag_removed: "verbatim",
  plan_set: "verbatim",
  record_set: "verbatim",
  files_changed: "verbatim",
  assignee_added: "dropped",
  assignee_removed: "dropped",
  criterion_added: "criteria",
  criterion_removed: "criteria",
  criterion_edited: "criteria",
  criterion_checked: "criteria",
  criterion_unchecked: "criteria",
  decision_added: "decisions",
  decision_removed: "decisions",
  decision_edited: "decisions",
  link_added: "verbatim",
  link_removed: "verbatim",
  link_updated: "verbatim",
  edge_added: "tasks",
  edge_removed: "tasks",
  edge_updated: "tasks",
  project_created: "verbatim",
  note_created: "verbatim",
  note_updated: "verbatim",
  note_moved: "verbatim",
  note_deleted: "verbatim",
  note_restored: "verbatim",
} as const satisfies Record<
  ArchiveActivityEventType,
  "criteria" | "decisions" | "tasks" | "verbatim" | "dropped"
>;

/**
 * Remap an activity event target into destination-local identifiers.
 *
 * @param event - Activity event being restored.
 * @param maps - Complete archive id maps.
 * @returns Remapped target reference or null.
 */
function remapActivityTarget(
  event: OrganizationArchive["activityEvents"][number],
  maps: ArchiveIdMaps,
): string | null {
  if (event.targetRef === null) return null;
  const remap = ACTIVITY_TARGET_REMAP[event.type];
  if (remap === "dropped") return null;
  if (remap === "verbatim") return event.targetRef;
  // A target deleted before export has no archive row to remap through;
  // keep the dangling source ref — the source workspace dangles identically,
  // and nulling it would erase which target the event acted on.
  return maps[remap].get(event.targetRef) ?? event.targetRef;
}

/**
 * Export every organization-visible workspace row under the owner's RLS scope.
 *
 * @param userId - Authenticated exporting user id.
 * @param organizationId - Organization whose workspace should be exported.
 * @returns Strict version-1 organization archive.
 * @throws {OrganizationExportForbiddenError} When the id is malformed, the
 *   organization is missing, or the caller is not an owner.
 * @throws {OrganizationArchiveError} When stored data cannot fit the archive.
 */
export async function exportOrganizationWorkspace(
  userId: string,
  organizationId: string,
): Promise<OrganizationArchive> {
  if (!UUID_RE.test(organizationId)) {
    throw new OrganizationExportForbiddenError();
  }

  const organization = await reserveOrganizationExport(userId, organizationId);
  await assertOrganizationExportWithinBounds(userId, organizationId);

  const [
    projectRows,
    taskRows,
    taskEdgeRows,
    assignmentRows,
    criterionRows,
    decisionRows,
    taskLinkRows,
    activityRows,
    noteRows,
    folderRows,
    noteTaskLinkRows,
    noteFeedTaskRows,
    noteLinkRows,
    revisionRows,
  ] = await withUserContextRead(userId, (read) => [
    read
      .select({
        sourceId: projects.id,
        title: projects.title,
        identifier: projects.identifier,
        description: projects.description,
        status: projects.status,
        categories: projects.categories,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        metaUpdatedAt: projects.metaUpdatedAt,
      })
      .from(projects)
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(projects.createdAt), asc(projects.id)),
    read
      .select({
        sourceId: tasks.id,
        projectSourceId: tasks.projectId,
        title: tasks.title,
        sequenceNumber: tasks.sequenceNumber,
        description: tasks.description,
        status: tasks.status,
        order: tasks.order,
        category: tasks.category,
        implementationPlan: tasks.implementationPlan,
        executionRecord: tasks.executionRecord,
        tags: tasks.tags,
        priority: tasks.priority,
        estimate: tasks.estimate,
        files: tasks.files,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        metaUpdatedAt: tasks.metaUpdatedAt,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(tasks.createdAt), asc(tasks.id)),
    read
      .select({
        sourceId: taskEdges.id,
        sourceTaskSourceId: taskEdges.sourceTaskId,
        targetTaskSourceId: taskEdges.targetTaskId,
        edgeType: taskEdges.edgeType,
        note: taskEdges.note,
        createdAt: taskEdges.createdAt,
        updatedAt: taskEdges.updatedAt,
        metaUpdatedAt: taskEdges.metaUpdatedAt,
      })
      .from(taskEdges)
      .innerJoin(tasks, eq(tasks.id, taskEdges.sourceTaskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(taskEdges.createdAt), asc(taskEdges.id)),
    read
      .select({
        taskSourceId: taskAssignees.taskId,
        createdAt: taskAssignees.createdAt,
      })
      .from(taskAssignees)
      .innerJoin(tasks, eq(tasks.id, taskAssignees.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        sql`${projects.organizationId} = ${organizationId}::uuid
            AND ${taskAssignees.userId} = ${userId}::uuid`,
      )
      .orderBy(asc(taskAssignees.taskId)),
    read
      .select({
        sourceId: taskAcceptanceCriteria.id,
        taskSourceId: taskAcceptanceCriteria.taskId,
        text: taskAcceptanceCriteria.text,
        checked: taskAcceptanceCriteria.checked,
        position: taskAcceptanceCriteria.position,
        createdAt: taskAcceptanceCriteria.createdAt,
        updatedAt: taskAcceptanceCriteria.updatedAt,
      })
      .from(taskAcceptanceCriteria)
      .innerJoin(tasks, eq(tasks.id, taskAcceptanceCriteria.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(
        asc(taskAcceptanceCriteria.createdAt),
        asc(taskAcceptanceCriteria.id),
      ),
    read
      .select({
        sourceId: taskDecisions.id,
        taskSourceId: taskDecisions.taskId,
        text: taskDecisions.text,
        source: taskDecisions.source,
        decisionDate: taskDecisions.decisionDate,
        position: taskDecisions.position,
        createdAt: taskDecisions.createdAt,
        updatedAt: taskDecisions.updatedAt,
      })
      .from(taskDecisions)
      .innerJoin(tasks, eq(tasks.id, taskDecisions.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(taskDecisions.createdAt), asc(taskDecisions.id)),
    read
      .select({
        sourceId: taskLinks.id,
        taskSourceId: taskLinks.taskId,
        kind: taskLinks.kind,
        url: taskLinks.url,
        label: taskLinks.label,
        createdAt: taskLinks.createdAt,
        createdBy: taskLinks.createdBy,
      })
      .from(taskLinks)
      .innerJoin(tasks, eq(tasks.id, taskLinks.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(taskLinks.createdAt), asc(taskLinks.id)),
    read
      .select({
        sourceId: activityEvents.id,
        projectSourceId: activityEvents.projectId,
        taskSourceId: activityEvents.taskId,
        noteSourceId: activityEvents.noteId,
        type: activityEvents.type,
        createdAt: activityEvents.createdAt,
        actorUserId: activityEvents.actorUserId,
        source: activityEvents.source,
        summary: activityEvents.summary,
        targetRef: activityEvents.targetRef,
        metadata: activityEvents.metadata,
      })
      .from(activityEvents)
      .innerJoin(projects, eq(projects.id, activityEvents.projectId))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(activityEvents.createdAt), asc(activityEvents.id)),
    read
      .select({
        sourceId: notes.id,
        projectSourceId: notes.projectId,
        sequenceNumber: notes.sequenceNumber,
        type: notes.type,
        folder: notes.folder,
        title: notes.title,
        slug: notes.slug,
        summary: notes.summary,
        body: notes.body,
        visibility: notes.visibility,
        sharedSince: notes.sharedSince,
        agentWritable: notes.agentWritable,
        locked: notes.locked,
        feedMode: notes.feedMode,
        feedCategories: notes.feedCategories,
        feedTags: notes.feedTags,
        tags: notes.tags,
        category: notes.category,
        version: notes.version,
        shareRequestedBy: notes.shareRequestedBy,
        createdBy: notes.createdBy,
        updatedBy: notes.updatedBy,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
        metaUpdatedAt: notes.metaUpdatedAt,
        deletedAt: notes.deletedAt,
      })
      .from(notes)
      .innerJoin(projects, eq(projects.id, notes.projectId))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(notes.createdAt), asc(notes.id)),
    read
      .select({
        sourceId: noteFolders.id,
        projectSourceId: noteFolders.projectId,
        path: noteFolders.path,
        createdAt: noteFolders.createdAt,
      })
      .from(noteFolders)
      .innerJoin(projects, eq(projects.id, noteFolders.projectId))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(noteFolders.createdAt), asc(noteFolders.id)),
    read
      .select({
        sourceId: noteTaskLinks.id,
        noteSourceId: noteTaskLinks.noteId,
        taskSourceId: noteTaskLinks.taskId,
        kind: noteTaskLinks.kind,
        createdAt: noteTaskLinks.createdAt,
      })
      .from(noteTaskLinks)
      .innerJoin(notes, eq(notes.id, noteTaskLinks.noteId))
      .innerJoin(projects, eq(projects.id, notes.projectId))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(noteTaskLinks.createdAt), asc(noteTaskLinks.id)),
    read
      .select({
        sourceId: noteFeedTasks.id,
        noteSourceId: noteFeedTasks.noteId,
        taskSourceId: noteFeedTasks.taskId,
        createdAt: noteFeedTasks.createdAt,
      })
      .from(noteFeedTasks)
      .innerJoin(notes, eq(notes.id, noteFeedTasks.noteId))
      .innerJoin(projects, eq(projects.id, notes.projectId))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(noteFeedTasks.createdAt), asc(noteFeedTasks.id)),
    read
      .select({
        sourceId: noteLinks.id,
        sourceNoteSourceId: noteLinks.sourceNoteId,
        targetNoteSourceId: noteLinks.targetNoteId,
        createdAt: noteLinks.createdAt,
      })
      .from(noteLinks)
      .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
      .innerJoin(projects, eq(projects.id, notes.projectId))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(noteLinks.createdAt), asc(noteLinks.id)),
    read
      .select({
        sourceId: noteRevisions.id,
        noteSourceId: noteRevisions.noteId,
        version: noteRevisions.version,
        title: noteRevisions.title,
        body: noteRevisions.body,
        createdBy: noteRevisions.createdBy,
        createdAt: noteRevisions.createdAt,
      })
      .from(noteRevisions)
      .innerJoin(notes, eq(notes.id, noteRevisions.noteId))
      .innerJoin(projects, eq(projects.id, notes.projectId))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(noteRevisions.createdAt), asc(noteRevisions.id)),
  ]);

  return parseOrganizationArchive({
    format: "piyaz-organization",
    version: 1,
    exportedAt: new Date().toISOString(),
    organization: { name: organization.name, slug: organization.slug },
    projects: projectRows.map((row) => ({
      ...row,
      createdAt: isoTimestamp(row.createdAt),
      updatedAt: isoTimestamp(row.updatedAt),
      metaUpdatedAt: isoTimestamp(row.metaUpdatedAt),
    })),
    tasks: taskRows.map((row) => ({
      ...row,
      createdAt: isoTimestamp(row.createdAt),
      updatedAt: isoTimestamp(row.updatedAt),
      metaUpdatedAt: isoTimestamp(row.metaUpdatedAt),
    })),
    taskEdges: taskEdgeRows.map((row) => ({
      ...row,
      createdAt: isoTimestamp(row.createdAt),
      updatedAt: isoTimestamp(row.updatedAt),
      metaUpdatedAt: isoTimestamp(row.metaUpdatedAt),
    })),
    taskAssignments: assignmentRows.map((row) => ({
      taskSourceId: row.taskSourceId,
      createdAt: isoTimestamp(row.createdAt),
    })),
    taskAcceptanceCriteria: criterionRows.map((row) => ({
      ...row,
      createdAt: isoTimestamp(row.createdAt),
      updatedAt: isoTimestamp(row.updatedAt),
    })),
    taskDecisions: decisionRows.map((row) => ({
      ...row,
      createdAt: isoTimestamp(row.createdAt),
      updatedAt: isoTimestamp(row.updatedAt),
    })),
    taskLinks: taskLinkRows.map((row) => ({
      sourceId: row.sourceId,
      taskSourceId: row.taskSourceId,
      kind: row.kind,
      url: row.url,
      label: row.label,
      createdAt: isoTimestamp(row.createdAt),
      createdBy: attribution(row.createdBy, userId),
    })),
    activityEvents: activityRows.map((row) => ({
      sourceId: row.sourceId,
      projectSourceId: row.projectSourceId,
      taskSourceId: row.taskSourceId,
      noteSourceId: row.noteSourceId,
      type: row.type,
      createdAt: isoTimestamp(row.createdAt),
      actor: attribution(row.actorUserId, userId),
      source: row.source,
      summary: row.summary,
      targetRef:
        row.type === "assignee_added" || row.type === "assignee_removed"
          ? null
          : row.targetRef,
      metadata: portableActivityMetadata(row.metadata),
    })),
    notes: noteRows.map((row) => ({
      sourceId: row.sourceId,
      projectSourceId: row.projectSourceId,
      sequenceNumber: row.sequenceNumber,
      type: row.type,
      folder: row.folder,
      title: row.title,
      slug: row.slug,
      summary: row.summary,
      body: row.body,
      visibility: row.visibility,
      sharedSince: nullableIsoTimestamp(row.sharedSince),
      agentWritable: row.agentWritable,
      locked: row.locked,
      feedMode: row.feedMode,
      feedCategories: row.feedCategories,
      feedTags: row.feedTags,
      tags: row.tags,
      category: row.category,
      version: row.version,
      shareRequestedBy: attribution(row.shareRequestedBy, userId),
      createdBy: attribution(row.createdBy, userId),
      updatedBy: attribution(row.updatedBy, userId),
      createdAt: isoTimestamp(row.createdAt),
      updatedAt: isoTimestamp(row.updatedAt),
      metaUpdatedAt: isoTimestamp(row.metaUpdatedAt),
      deletedAt: nullableIsoTimestamp(row.deletedAt),
    })),
    noteFolders: folderRows.map((row) => ({
      ...row,
      createdAt: isoTimestamp(row.createdAt),
    })),
    noteTaskLinks: noteTaskLinkRows.map((row) => ({
      ...row,
      createdAt: isoTimestamp(row.createdAt),
    })),
    noteFeedTasks: noteFeedTaskRows.map((row) => ({
      ...row,
      createdAt: isoTimestamp(row.createdAt),
    })),
    noteLinks: noteLinkRows.map((row) => ({
      ...row,
      createdAt: isoTimestamp(row.createdAt),
    })),
    noteRevisions: revisionRows.map((row) => ({
      sourceId: row.sourceId,
      noteSourceId: row.noteSourceId,
      version: row.version,
      title: row.title,
      body: row.body,
      createdBy: attribution(row.createdBy, userId),
      createdAt: isoTimestamp(row.createdAt),
    })),
  });
}

/**
 * Restore a validated workspace archive into an existing empty organization.
 *
 * The archive must already have passed `parseOrganizationArchive` (the import
 * route decodes with `decodeOrganizationArchive`); re-validating here would
 * deep-clone the complete archive inside a memory-bounded isolate.
 * Because archives are editable, restored activity is visibly prefixed as
 * imported and attributed to the importer; original source metadata remains
 * available without granting an archive trusted system or MCP provenance.
 *
 * @param userId - Importing organization owner's user id.
 * @param organizationId - Fresh destination organization id.
 * @param archive - Validated version-1 organization archive.
 * @returns Counts of the primary restored workspace rows.
 * @throws {OrganizationArchiveError} When the validated graph is inconsistent.
 * @throws Error when any database write fails; the transaction rolls back.
 */
export async function importOrganizationWorkspace(
  userId: string,
  organizationId: string,
  archive: OrganizationArchive,
): Promise<OrganizationImportSummary> {
  const maps = createArchiveIdMaps(archive);

  return withUserContext(userId, async (tx) => {
    const projectValues = archive.projects.map((row) => ({
      id: mappedId(maps.projects, row.sourceId, "projects"),
      organizationId,
      title: row.title,
      identifier: row.identifier,
      description: row.description,
      status: row.status,
      categories: row.categories,
      createdAt: archiveDate(row.createdAt),
      updatedAt: archiveDate(row.updatedAt),
      metaUpdatedAt: archiveDate(row.metaUpdatedAt),
    }));
    await insertBatches(projectValues, (batch) =>
      tx.insert(projects).values(batch),
    );

    const taskValues = archive.tasks.map((row) => ({
      id: mappedId(maps.tasks, row.sourceId, "tasks"),
      projectId: mappedId(maps.projects, row.projectSourceId, "projects"),
      title: row.title,
      sequenceNumber: row.sequenceNumber,
      description: row.description,
      status: row.status,
      order: row.order,
      category: row.category,
      implementationPlan: row.implementationPlan,
      executionRecord: row.executionRecord,
      tags: row.tags,
      priority: row.priority,
      estimate: row.estimate,
      files: row.files,
      createdAt: archiveDate(row.createdAt),
      updatedAt: archiveDate(row.updatedAt),
      metaUpdatedAt: archiveDate(row.metaUpdatedAt),
    }));
    await insertBatches(taskValues, (batch) => tx.insert(tasks).values(batch));

    const taskEdgeValues = archive.taskEdges.map((row) => ({
      id: mappedId(maps.taskEdges, row.sourceId, "taskEdges"),
      sourceTaskId: mappedId(maps.tasks, row.sourceTaskSourceId, "tasks"),
      targetTaskId: mappedId(maps.tasks, row.targetTaskSourceId, "tasks"),
      edgeType: row.edgeType,
      note: row.note,
      createdAt: archiveDate(row.createdAt),
      updatedAt: archiveDate(row.updatedAt),
      metaUpdatedAt: archiveDate(row.metaUpdatedAt),
    }));
    await insertBatches(taskEdgeValues, (batch) =>
      tx.insert(taskEdges).values(batch),
    );

    const assignmentValues = archive.taskAssignments.map((row) => ({
      taskId: mappedId(maps.tasks, row.taskSourceId, "tasks"),
      userId,
      createdAt: archiveDate(row.createdAt),
    }));
    await insertBatches(assignmentValues, (batch) =>
      tx.insert(taskAssignees).values(batch),
    );

    const criterionValues = archive.taskAcceptanceCriteria.map((row) => ({
      id: mappedId(maps.criteria, row.sourceId, "taskAcceptanceCriteria"),
      taskId: mappedId(maps.tasks, row.taskSourceId, "tasks"),
      text: row.text,
      checked: row.checked,
      position: row.position,
      createdAt: archiveDate(row.createdAt),
      updatedAt: archiveDate(row.updatedAt),
    }));
    await insertBatches(criterionValues, (batch) =>
      tx.insert(taskAcceptanceCriteria).values(batch),
    );

    const decisionValues = archive.taskDecisions.map((row) => ({
      id: mappedId(maps.decisions, row.sourceId, "taskDecisions"),
      taskId: mappedId(maps.tasks, row.taskSourceId, "tasks"),
      text: row.text,
      source: row.source,
      decisionDate: row.decisionDate,
      position: row.position,
      createdAt: archiveDate(row.createdAt),
      updatedAt: archiveDate(row.updatedAt),
    }));
    await insertBatches(decisionValues, (batch) =>
      tx.insert(taskDecisions).values(batch),
    );

    const taskLinkValues = archive.taskLinks.map((row) => ({
      id: mappedId(maps.taskLinks, row.sourceId, "taskLinks"),
      taskId: mappedId(maps.tasks, row.taskSourceId, "tasks"),
      kind: row.kind,
      url: row.url,
      label: row.label,
      createdAt: archiveDate(row.createdAt),
      createdBy: importedAttribution(row.createdBy, userId),
    }));
    await insertBatches(taskLinkValues, (batch) =>
      tx.insert(taskLinks).values(batch),
    );

    const noteValues = archive.notes.map((row) => ({
      id: mappedId(maps.notes, row.sourceId, "notes"),
      projectId: mappedId(maps.projects, row.projectSourceId, "projects"),
      sequenceNumber: row.sequenceNumber,
      type: row.type,
      folder: row.folder,
      title: row.title,
      slug: row.slug,
      summary: row.summary,
      body: row.body,
      visibility: row.visibility,
      sharedSince: nullableArchiveDate(row.sharedSince),
      agentWritable: row.agentWritable,
      locked: row.locked,
      feedMode: row.feedMode,
      feedCategories: row.feedCategories,
      feedTags: row.feedTags,
      tags: row.tags,
      category: row.category,
      version: row.version,
      shareRequestedBy: importedAttribution(row.shareRequestedBy, userId),
      createdBy: userId,
      updatedBy: importedAttribution(row.updatedBy, userId),
      createdAt: archiveDate(row.createdAt),
      updatedAt: archiveDate(row.updatedAt),
      metaUpdatedAt: archiveDate(row.metaUpdatedAt),
      deletedAt: nullableArchiveDate(row.deletedAt),
    }));
    await insertBatches(noteValues, (batch) => tx.insert(notes).values(batch));

    const folderValues = archive.noteFolders.map((row) => ({
      id: mappedId(maps.noteFolders, row.sourceId, "noteFolders"),
      projectId: mappedId(maps.projects, row.projectSourceId, "projects"),
      path: row.path,
      createdBy: userId,
      createdAt: archiveDate(row.createdAt),
    }));
    await insertBatches(folderValues, (batch) =>
      tx.insert(noteFolders).values(batch),
    );

    const noteTaskLinkValues = archive.noteTaskLinks.map((row) => ({
      id: mappedId(maps.noteTaskLinks, row.sourceId, "noteTaskLinks"),
      noteId: mappedId(maps.notes, row.noteSourceId, "notes"),
      taskId: mappedId(maps.tasks, row.taskSourceId, "tasks"),
      kind: row.kind,
      createdAt: archiveDate(row.createdAt),
    }));
    await insertBatches(noteTaskLinkValues, (batch) =>
      tx.insert(noteTaskLinks).values(batch),
    );

    const noteFeedTaskValues = archive.noteFeedTasks.map((row) => ({
      id: mappedId(maps.noteFeedTasks, row.sourceId, "noteFeedTasks"),
      noteId: mappedId(maps.notes, row.noteSourceId, "notes"),
      taskId: mappedId(maps.tasks, row.taskSourceId, "tasks"),
      createdAt: archiveDate(row.createdAt),
    }));
    await insertBatches(noteFeedTaskValues, (batch) =>
      tx.insert(noteFeedTasks).values(batch),
    );

    const noteLinkValues = archive.noteLinks.map((row) => ({
      id: mappedId(maps.noteLinks, row.sourceId, "noteLinks"),
      sourceNoteId: mappedId(maps.notes, row.sourceNoteSourceId, "notes"),
      targetNoteId: mappedId(maps.notes, row.targetNoteSourceId, "notes"),
      createdAt: archiveDate(row.createdAt),
    }));
    await insertBatches(noteLinkValues, (batch) =>
      tx.insert(noteLinks).values(batch),
    );

    const revisionValues = archive.noteRevisions.map((row) => ({
      id: mappedId(maps.noteRevisions, row.sourceId, "noteRevisions"),
      noteId: mappedId(maps.notes, row.noteSourceId, "notes"),
      version: row.version,
      title: row.title,
      body: row.body,
      createdBy: importedAttribution(row.createdBy, userId),
      createdAt: archiveDate(row.createdAt),
    }));
    await insertBatches(revisionValues, (batch) =>
      tx.insert(noteRevisions).values(batch),
    );

    const activityValues = archive.activityEvents.map((row) => ({
      id: mappedId(maps.activityEvents, row.sourceId, "activityEvents"),
      projectId: mappedId(maps.projects, row.projectSourceId, "projects"),
      taskId:
        row.taskSourceId === null
          ? null
          : mappedId(maps.tasks, row.taskSourceId, "tasks"),
      noteId:
        row.noteSourceId === null
          ? null
          : mappedId(maps.notes, row.noteSourceId, "notes"),
      type: row.type,
      createdAt: archiveDate(row.createdAt),
      actorUserId: userId,
      source: "web" as const,
      actorClientId: null,
      summary: `${IMPORTED_ACTIVITY_SUMMARY_PREFIX}${row.summary}`,
      targetRef: remapActivityTarget(row, maps),
      metadata: {
        ...(portableActivityMetadata(row.metadata) ?? {}),
        portabilityImport: {
          originalActor: row.actor,
          originalSource: row.source,
        },
      },
    }));
    await insertBatches(activityValues, (batch) =>
      tx.insert(activityEvents).values(batch),
    );

    await restoreClockBatches(taskEdgeValues, (batch) =>
      restoreArchiveClocks(
        tx,
        "taskEdges",
        batch.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          metaUpdatedAt: row.metaUpdatedAt.toISOString(),
        })),
      ),
    );
    await restoreClockBatches(noteValues, (batch) =>
      restoreArchiveClocks(
        tx,
        "notes",
        batch.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          metaUpdatedAt: row.metaUpdatedAt.toISOString(),
        })),
      ),
    );
    await restoreClockBatches(taskValues, (batch) =>
      restoreArchiveClocks(
        tx,
        "tasks",
        batch.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          metaUpdatedAt: row.metaUpdatedAt.toISOString(),
        })),
      ),
    );
    await restoreClockBatches(projectValues, (batch) =>
      restoreArchiveClocks(
        tx,
        "projects",
        batch.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          metaUpdatedAt: row.metaUpdatedAt.toISOString(),
        })),
      ),
    );

    return {
      projectCount: archive.projects.length,
      taskCount: archive.tasks.length,
      noteCount: archive.notes.length,
      activityEventCount: archive.activityEvents.length,
    };
  });
}
