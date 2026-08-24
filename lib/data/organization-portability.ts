/** RLS-scoped organization workspace export and restore operations. */

import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { parseMemberRoles } from "@/lib/auth/permissions";
import { toDate } from "@/lib/db/raw";
import { withUserContextRead } from "@/lib/db/rls";
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
