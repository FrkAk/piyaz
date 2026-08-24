/** RLS-scoped organization workspace export and restore operations. */

import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { parseMemberRoles } from "@/lib/auth/permissions";
import { toDate } from "@/lib/db/raw";
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
  projects,
  taskAcceptanceCriteria,
  taskAssignees,
  taskDecisions,
  taskEdges,
  taskLinks,
  tasks,
} from "@/lib/db/schema";
import {
  OrganizationArchiveError,
  parseOrganizationArchive,
  type OrganizationArchive,
} from "@/lib/organization-portability/archive";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSERT_BATCH_SIZE = 500;

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
 * Require JSON metadata to be a record when present.
 *
 * @param value - JSONB value returned by the database.
 * @returns Record metadata or null.
 * @throws {OrganizationArchiveError} When legacy data has another JSON shape.
 */
function recordMetadata(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new OrganizationArchiveError(
    "Workspace metadata does not match archive version 1",
  );
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
  if (event.type.startsWith("criterion_")) {
    return maps.criteria.get(event.targetRef) ?? null;
  }
  if (event.type.startsWith("decision_")) {
    return maps.decisions.get(event.targetRef) ?? null;
  }
  if (event.type.startsWith("edge_")) {
    return maps.tasks.get(event.targetRef) ?? null;
  }
  if (event.type.startsWith("assignee_")) return null;
  return event.targetRef;
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

  const [
    organizationRows,
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
        orgId: sql<string>`org_id`,
        name: sql<string>`name`,
        slug: sql<string>`slug`,
        memberRole: sql<string>`member_role`,
      })
      .from(sql`public.current_user_orgs()`)
      .where(sql`org_id = ${organizationId}::uuid`)
      .limit(1),
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
        metadata: taskLinks.metadata,
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
        embeddingStatus: notes.embeddingStatus,
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

  const [organization] = organizationRows;
  if (
    !organization ||
    !parseMemberRoles(organization.memberRole).includes("owner")
  ) {
    throw new OrganizationExportForbiddenError();
  }

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
      metadata: recordMetadata(row.metadata),
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
      metadata: row.metadata,
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
      embeddingStatus: row.embeddingStatus,
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
 * @param userId - Importing organization owner's user id.
 * @param organizationId - Fresh destination organization id.
 * @param archive - Validated version-1 organization archive.
 * @returns Counts of the primary restored workspace rows.
 * @throws {OrganizationArchiveError} When the archive has become invalid.
 * @throws Error when any database write fails; the transaction rolls back.
 */
export async function importOrganizationWorkspace(
  userId: string,
  organizationId: string,
  archive: OrganizationArchive,
): Promise<OrganizationImportSummary> {
  const validated = parseOrganizationArchive(archive);
  const maps = createArchiveIdMaps(validated);

  return withUserContext(userId, async (tx) => {
    const projectValues = validated.projects.map((row) => ({
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

    const taskValues = validated.tasks.map((row) => ({
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

    const taskEdgeValues = validated.taskEdges.map((row) => ({
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

    const assignmentValues = validated.taskAssignments.map((row) => ({
      taskId: mappedId(maps.tasks, row.taskSourceId, "tasks"),
      userId,
      createdAt: archiveDate(row.createdAt),
    }));
    await insertBatches(assignmentValues, (batch) =>
      tx.insert(taskAssignees).values(batch),
    );

    const criterionValues = validated.taskAcceptanceCriteria.map((row) => ({
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

    const decisionValues = validated.taskDecisions.map((row) => ({
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

    const taskLinkValues = validated.taskLinks.map((row) => ({
      id: mappedId(maps.taskLinks, row.sourceId, "taskLinks"),
      taskId: mappedId(maps.tasks, row.taskSourceId, "tasks"),
      kind: row.kind,
      url: row.url,
      label: row.label,
      createdAt: archiveDate(row.createdAt),
      createdBy: importedAttribution(row.createdBy, userId),
      metadata: row.metadata,
    }));
    await insertBatches(taskLinkValues, (batch) =>
      tx.insert(taskLinks).values(batch),
    );

    const noteValues = validated.notes.map((row) => ({
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
      embeddingStatus: row.embeddingStatus,
      shareRequestedBy: importedAttribution(row.shareRequestedBy, userId),
      createdBy: userId,
      updatedBy: importedAttribution(row.updatedBy, userId),
      createdAt: archiveDate(row.createdAt),
      updatedAt: archiveDate(row.updatedAt),
      metaUpdatedAt: archiveDate(row.metaUpdatedAt),
      deletedAt: nullableArchiveDate(row.deletedAt),
    }));
    await insertBatches(noteValues, (batch) => tx.insert(notes).values(batch));

    const folderValues = validated.noteFolders.map((row) => ({
      id: mappedId(maps.noteFolders, row.sourceId, "noteFolders"),
      projectId: mappedId(maps.projects, row.projectSourceId, "projects"),
      path: row.path,
      createdBy: userId,
      createdAt: archiveDate(row.createdAt),
    }));
    await insertBatches(folderValues, (batch) =>
      tx.insert(noteFolders).values(batch),
    );

    const noteTaskLinkValues = validated.noteTaskLinks.map((row) => ({
      id: mappedId(maps.noteTaskLinks, row.sourceId, "noteTaskLinks"),
      noteId: mappedId(maps.notes, row.noteSourceId, "notes"),
      taskId: mappedId(maps.tasks, row.taskSourceId, "tasks"),
      kind: row.kind,
      createdAt: archiveDate(row.createdAt),
    }));
    await insertBatches(noteTaskLinkValues, (batch) =>
      tx.insert(noteTaskLinks).values(batch),
    );

    const noteFeedTaskValues = validated.noteFeedTasks.map((row) => ({
      id: mappedId(maps.noteFeedTasks, row.sourceId, "noteFeedTasks"),
      noteId: mappedId(maps.notes, row.noteSourceId, "notes"),
      taskId: mappedId(maps.tasks, row.taskSourceId, "tasks"),
      createdAt: archiveDate(row.createdAt),
    }));
    await insertBatches(noteFeedTaskValues, (batch) =>
      tx.insert(noteFeedTasks).values(batch),
    );

    const noteLinkValues = validated.noteLinks.map((row) => ({
      id: mappedId(maps.noteLinks, row.sourceId, "noteLinks"),
      sourceNoteId: mappedId(maps.notes, row.sourceNoteSourceId, "notes"),
      targetNoteId: mappedId(maps.notes, row.targetNoteSourceId, "notes"),
      createdAt: archiveDate(row.createdAt),
    }));
    await insertBatches(noteLinkValues, (batch) =>
      tx.insert(noteLinks).values(batch),
    );

    const revisionValues = validated.noteRevisions.map((row) => ({
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

    const activityValues = validated.activityEvents.map((row) => ({
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
      actorUserId: importedAttribution(row.actor, userId),
      source: row.source,
      actorClientId: null,
      summary: row.summary,
      targetRef: remapActivityTarget(row, maps),
      metadata: row.metadata,
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
    await restoreClockBatches(criterionValues, (batch) =>
      restoreArchiveClocks(
        tx,
        "taskAcceptanceCriteria",
        batch.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      ),
    );
    await restoreClockBatches(decisionValues, (batch) =>
      restoreArchiveClocks(
        tx,
        "taskDecisions",
        batch.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
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
      projectCount: validated.projects.length,
      taskCount: validated.tasks.length,
      noteCount: validated.notes.length,
      activityEventCount: validated.activityEvents.length,
    };
  });
}
