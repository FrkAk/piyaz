import "server-only";

import {
  aliasedTable,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import { serviceRoleDb } from "@/lib/db";
import {
  executeRaw,
  normalizeExecuteResult,
  type Conn,
  type ReadConn,
} from "@/lib/db/raw";
import { withUserContext, withUserContextRead, type Tx } from "@/lib/db/rls";
import {
  noteLinks,
  notes,
  noteTaskLinks,
  projects,
  tasks,
  taskEdges,
} from "@/lib/db/schema";
import {
  assigneeCountExpr,
  assigneeUserIdsExpr,
  hasCriteriaExpr,
} from "@/lib/data/task";
import { slimEdgeColumns } from "@/lib/data/edge-columns";
import { acquireOrgIdentifierLock } from "@/lib/db/raw/acquire-org-identifier-lock";
import {
  aggregateProjectTags,
  mapProjectTagRows,
  projectTagsStmt,
} from "@/lib/db/raw/aggregate-project-tags";
import { getProjectListMaxUpdatedAtRaw } from "@/lib/db/raw/get-project-list-max-updated-at";
import {
  getProjectMaxUpdatedAtRaw,
  type ProjectValidatorMode,
} from "@/lib/db/raw/get-project-max-updated-at";
import { insertActivityEvents } from "@/lib/data/activity";
import {
  NOTE_TASK_LINK_KIND_RANK,
  type ProjectStatus,
  type TaskStatus,
} from "@/lib/types";
import { STATUS_BUCKET } from "@/lib/data/views";
import {
  asIdentifier,
  composeNoteRef,
  deriveIdentifier,
  enrichWithTaskRef,
  type Identifier,
} from "@/lib/graph/identifier";
import type {
  NoteGraphSlim,
  NoteTaskGraphEdge,
  ProjectChrome,
  ProjectGraphSlim,
  ProjectIndexEntry,
  ProjectListEntry,
  ProjectListEntryMcp,
  ProjectMeta,
  ProjectSlim,
  ProjectTaskStats,
  TaskGraphSlim,
} from "@/lib/data/views";
import {
  IdentifierAllocationError,
  MultiTeamAmbiguityError,
  NoTeamMembershipError,
  ProjectNotFoundError,
  type TeamOption,
} from "@/lib/graph/errors";
import { formatMarkdown } from "@/lib/markdown/format";
import { deriveTaskStatesSlim } from "@/lib/data/task";
import type { AuthContext } from "@/lib/auth/context";
import {
  ForbiddenError,
  InsufficientRoleError,
  assertProjectAccess,
  assertProjectAccessTx,
  isUuid,
  type ProjectAccess,
} from "@/lib/auth/authorization";
import {
  emitProjectDeleted,
  emitProjectEvent,
  emitProjectListEvent,
} from "@/lib/realtime/events";
import { decodeCursor, encodeCursor, type Cursor } from "@/lib/data/cursor";

/**
 * Zeroed {@link ProjectTaskStats} accumulator for the status-grouped
 * progress roll-up.
 *
 * @returns Stats object with every bucket at 0.
 */
function emptyTaskStats(): ProjectTaskStats {
  return {
    total: 0,
    done: 0,
    inReview: 0,
    inProgress: 0,
    planned: 0,
    draft: 0,
    cancelled: 0,
  };
}

/**
 * Fold one status-grouped count into a stats accumulator. Unknown statuses
 * still contribute to `total` so the denominator stays whole.
 *
 * @param stats - Accumulator mutated in place.
 * @param status - Persisted task status the count belongs to.
 * @param count - Number of tasks with that status.
 */
function accumulateTaskStats(
  stats: ProjectTaskStats,
  status: string,
  count: number,
): void {
  stats.total += count;
  const bucket = STATUS_BUCKET[status as TaskStatus];
  if (bucket) stats[bucket] += count;
}
// ---------------------------------------------------------------------------
// Single-entity queries
// ---------------------------------------------------------------------------

/**
 * Guard a caller-supplied pre-resolved access row against the project the
 * read is scoped to. A mismatch is a programmer error — fail loudly rather
 * than serve one project's data under another project's authorization.
 *
 * @param access - Pre-resolved access row, when the caller supplied one.
 * @param projectId - UUID of the project being read.
 * @throws Error when the access row belongs to a different project.
 */
function assertAccessMatchesProject(
  access: ProjectAccess | undefined,
  projectId: string,
): void {
  if (access && access.project.id !== projectId) {
    throw new Error(
      `pre-resolved access row is for project ${access.project.id}, not ${projectId}`,
    );
  }
}

/**
 * Collapse note-task link rows to one edge per `(noteId, taskId)` pair,
 * keeping the most specific kind (`spec_of` > `reference` > `mention`).
 * Mirrors the backlink dedupe on the task detail surface so both read the
 * same rank table.
 *
 * @param rows - Distinct link rows, one per (pair, kind).
 * @returns Deduped edges, one per pair.
 */
function dedupeNoteTaskEdges(
  rows: readonly NoteTaskGraphEdge[],
): NoteTaskGraphEdge[] {
  const byPair = new Map<string, NoteTaskGraphEdge>();
  for (const row of rows) {
    const key = `${row.noteId}:${row.taskId}`;
    const existing = byPair.get(key);
    if (
      !existing ||
      NOTE_TASK_LINK_KIND_RANK[row.kind] >
        NOTE_TASK_LINK_KIND_RANK[existing.kind]
    ) {
      byPair.set(key, row);
    }
  }
  return [...byPair.values()];
}

/**
 * Slim graph payload for the workspace canvas + task list. Drops the heavy
 * task fields (description, plan, decisions, criteria, executionRecord)
 * that only the per-task detail surface needs — those are fetched lazily
 * via `GET /api/task/[id]`.
 *
 * Five column-projected selects run under `Promise.all`. The edges select
 * filters on `source_task_id` alone: the `task_edges_same_project_immutable`
 * trigger guarantees both endpoints share a project, so the source-side
 * index scan returns every intra-project edge exactly once — no second arm
 * or de-dupe needed. The same trigger pattern (`reject_note_links_cross_project`)
 * lets the note-link select filter on the source note's project alone. Note
 * visibility is pure RLS: `notes_member_access` (team notes plus the caller's
 * own private ones) and the both-endpoint policies on the link tables scope
 * every note row and edge — no app-level re-check. Note-task rows arrive
 * distinct per (pair, kind) and reduce to the strongest kind app-side via
 * {@link dedupeNoteTaskEdges}.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param access - Optional pre-resolved access row so the workspace render
 *   reuses one project-access read across the layout and page instead of
 *   reading the row again here. Must have been resolved for this same
 *   `projectId`; a mismatch throws. Omit to resolve it in-frame.
 * @returns Slim project metadata + slim tasks + slim edges + slim notes
 *   with their note-note and note-task edges.
 * @throws ForbiddenError on missing or cross-team project.
 * @throws Error when `access` was resolved for a different project.
 */
export async function getProjectGraphSlim(
  ctx: AuthContext,
  projectId: string,
  access?: ProjectAccess,
): Promise<ProjectGraphSlim> {
  assertAccessMatchesProject(access, projectId);
  return withUserContext(ctx.userId, async (tx) => {
    const { project } = access ?? (await assertProjectAccessTx(tx, projectId));

    const tasksQ = tx
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        category: tasks.category,
        tags: tasks.tags,
        priority: tasks.priority,
        estimate: tasks.estimate,
        order: tasks.order,
        updatedAt: tasks.metaUpdatedAt,
        sequenceNumber: tasks.sequenceNumber,
        hasDescription: sql<boolean>`length(btrim(${tasks.description})) > 0`,
        hasCriteria: hasCriteriaExpr(),
        hasExecutionRecord: sql<boolean>`${tasks.executionRecord} IS NOT NULL`,
        assigneeCount: assigneeCountExpr(),
        assigneeUserIds: assigneeUserIdsExpr(),
      })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(tasks.order));

    const edgesQ = tx
      .select(slimEdgeColumns)
      .from(taskEdges)
      .innerJoin(tasks, eq(taskEdges.sourceTaskId, tasks.id))
      .where(eq(tasks.projectId, projectId));

    const notesQ = tx
      .select({
        id: notes.id,
        sequenceNumber: notes.sequenceNumber,
        title: notes.title,
        type: notes.type,
        feedMode: notes.feedMode,
      })
      .from(notes)
      .where(and(eq(notes.projectId, projectId), isNull(notes.deletedAt)))
      .orderBy(asc(notes.sequenceNumber));

    const noteTaskLinksQ = tx
      .selectDistinct({
        noteId: noteTaskLinks.noteId,
        taskId: noteTaskLinks.taskId,
        kind: noteTaskLinks.kind,
      })
      .from(noteTaskLinks)
      .innerJoin(notes, eq(notes.id, noteTaskLinks.noteId))
      .where(and(eq(notes.projectId, projectId), isNull(notes.deletedAt)));

    const targetNotes = aliasedTable(notes, "target_notes");
    const noteLinksQ = tx
      .select({
        sourceNoteId: noteLinks.sourceNoteId,
        targetNoteId: noteLinks.targetNoteId,
      })
      .from(noteLinks)
      .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
      .innerJoin(targetNotes, eq(targetNotes.id, noteLinks.targetNoteId))
      .where(
        and(
          eq(notes.projectId, projectId),
          isNull(notes.deletedAt),
          isNull(targetNotes.deletedAt),
        ),
      );

    const [taskRows, edges, noteRows, noteTaskRows, noteEdges] =
      await Promise.all([tasksQ, edgesQ, notesQ, noteTaskLinksQ, noteLinksQ]);
    const identifier = asIdentifier(project.identifier);
    const enriched = enrichWithTaskRef(taskRows, identifier);

    const slimNotes: NoteGraphSlim[] = noteRows.map((n) => ({
      id: n.id,
      noteRef: composeNoteRef(identifier, n.sequenceNumber),
      title: n.title,
      type: n.type,
      fed: n.feedMode !== "none",
    }));
    const noteTaskEdges = dedupeNoteTaskEdges(noteTaskRows);

    const stateMap = await deriveTaskStatesSlim(
      projectId,
      enriched.map((t) => ({
        id: t.id,
        status: t.status,
        hasDescription: t.hasDescription,
        hasCriteria: t.hasCriteria,
      })),
      tx,
    );

    const slimTasks: TaskGraphSlim[] = enriched.map((t) => ({
      id: t.id,
      taskRef: t.taskRef,
      title: t.title,
      status: t.status,
      category: t.category,
      tags: t.tags,
      priority: t.priority,
      estimate: t.estimate,
      order: t.order,
      updatedAt: t.updatedAt,
      hasDescription: t.hasDescription,
      hasCriteria: t.hasCriteria,
      hasExecutionRecord: t.hasExecutionRecord,
      state: stateMap.get(t.id) ?? "draft",
      assigneeCount: t.assigneeCount,
      assigneeUserIds: t.assigneeUserIds,
    }));

    return {
      project: {
        id: project.id,
        organizationId: project.organizationId,
        identifier: project.identifier,
        title: project.title,
        description: project.description,
        status: project.status,
        updatedAt: project.metaUpdatedAt,
        categories: project.categories,
      },
      tasks: slimTasks,
      edges,
      notes: slimNotes,
      noteLinks: noteEdges,
      noteTaskLinks: noteTaskEdges,
    };
  });
}

/**
 * Chrome data for the workspace layout: project header, caller role,
 * owning team, and total task count.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param access - Optional pre-resolved access row so the workspace render
 *   reuses one project-access read across the layout and page instead of
 *   reading the row again here. Must have been resolved for this same
 *   `projectId`; a mismatch throws. Omit to resolve it in-frame.
 * @returns Chrome view of the project.
 * @throws ForbiddenError on missing or cross-team project.
 * @throws Error when `access` was resolved for a different project.
 */
export async function getProjectChrome(
  ctx: AuthContext,
  projectId: string,
  access?: ProjectAccess,
): Promise<ProjectChrome> {
  assertAccessMatchesProject(access, projectId);
  return withUserContext(ctx.userId, async (tx) => {
    const {
      project,
      memberRole,
      organization: org,
    } = access ?? (await assertProjectAccessTx(tx, projectId));

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(eq(tasks.projectId, projectId));

    return {
      id: project.id,
      title: project.title,
      description: project.description,
      identifier: project.identifier,
      status: project.status,
      categories: project.categories,
      organization: org,
      memberRole,
      taskCount: count,
    };
  });
}

/**
 * Latest clock across the project, its tasks, and its edges (and a notes
 * clock per `mode`). Used by the conditional-GET path on the workspace
 * graph and context-bundle endpoints to short-circuit the heavy read on a
 * 304 response. The context route passes `content` (it embeds task and
 * note bodies, so any edit must move it); the graph route passes `meta`
 * (it renders only slim metadata, so plan/record/decision/link writes,
 * edge note edits, and note body edits must not move it).
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param mode - Which clocks to fold into the validator.
 * @returns The latest timestamp.
 * @throws ForbiddenError on missing or cross-team project.
 */
export async function getProjectMaxUpdatedAt(
  ctx: AuthContext,
  projectId: string,
  mode: ProjectValidatorMode = "none",
): Promise<Date> {
  return withUserContext(ctx.userId, async (tx) => {
    await assertProjectAccessTx(tx, projectId);
    const max = await getProjectMaxUpdatedAtRaw(tx, projectId, mode);
    if (!max) {
      throw new Error(
        `getProjectMaxUpdatedAt: project ${projectId} disappeared after access check`,
      );
    }
    return max;
  });
}

/**
 * Latest `updated_at` across every project the caller can access plus every
 * task and edge in those projects. Used by `GET /api/projects` as the
 * conditional-GET validator on the home-grid list.
 *
 * @param ctx - Resolved auth context.
 * @returns Latest timestamp, or epoch-0 when the user has no accessible
 *   projects.
 */
export async function getProjectListMaxUpdatedAt(
  ctx: AuthContext,
): Promise<Date> {
  return withUserContext(ctx.userId, async (tx) =>
    getProjectListMaxUpdatedAtRaw(tx),
  );
}

/**
 * Project ids in a single organization, scoped to the caller's membership.
 * Internal — for trusted bookkeeping in org-membership hooks; do NOT expose
 * through any route that takes user-supplied input.
 *
 * @param userId - Verified user id of the member triggering the lookup.
 * @param organizationId - Organization UUID.
 * @returns Project ids in that org.
 */
export async function listOrgProjectIds(
  userId: string,
  organizationId: string,
): Promise<string[]> {
  return withUserContext(userId, async (tx) => {
    const rows = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.organizationId, organizationId));
    return rows.map((r) => r.id);
  });
}

/**
 * Admin lookup: project ids for an org, NOT scoped by caller membership.
 * Routes through `list_org_project_ids` (SECURITY DEFINER, service_role-only).
 * Used by Better Auth's `afterRemoveMember` hook, where the member row is
 * already gone and the caller-scoped variant returns [].
 *
 * @param orgId - UUID of the organization.
 * @returns Array of project ids in the organization.
 */
export async function listOrgProjectIdsAsAdmin(
  orgId: string,
): Promise<string[]> {
  const rows = await executeRaw<{ id: string }>(
    serviceRoleDb,
    sql`SELECT id FROM public.list_org_project_ids(${orgId}::uuid)`,
  );
  return rows.map((r) => r.id);
}

/**
 * Project ids the caller can access via team membership. Lightweight
 * companion to {@link listProjectsSlim} — no pagination, no decoration —
 * intended for the realtime broker's bulk-subscription registration on
 * SSE connect.
 *
 * @param ctx - Resolved auth context.
 * @returns Project ids across every team the caller belongs to.
 */
export async function listAccessibleProjectIds(
  ctx: AuthContext,
): Promise<string[]> {
  return withUserContext(ctx.userId, async (tx) => {
    const rows = await tx.select({ id: projects.id }).from(projects);
    return rows.map((r) => r.id);
  });
}

/**
 * Fetch only the columns slim listings consume. Membership-gated.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Slim project view.
 */
export async function getProjectSlim(
  ctx: AuthContext,
  projectId: string,
): Promise<ProjectSlim> {
  const { project } = await assertProjectAccess(projectId, ctx);
  return {
    id: project.id,
    identifier: project.identifier,
    title: project.title,
    status: project.status,
    organizationId: project.organizationId,
    updatedAt: project.updatedAt,
  };
}

/**
 * Fetch the project's identifier only. Internal helper for context
 * assemblers — caller has already asserted access on the parent task.
 *
 * @param projectId - UUID of the project.
 * @param conn - RLS-scoped {@link Conn} from an active `withUserContext` frame.
 * @returns The identifier string, or null when the project is missing.
 */
export async function getProjectIdentifier(
  projectId: string,
  conn: Conn,
): Promise<string | null> {
  const [row] = await conn
    .select({ identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.identifier ?? null;
}

/** Header fields a context assembler needs to render the project chrome. */
export type ProjectHeader = {
  title: string;
  description: string;
  identifier: string;
};

/**
 * Fetch title/description/identifier for a project. Internal helper for
 * context assemblers — caller has already asserted access on the parent
 * task.
 *
 * @param projectId - UUID of the project.
 * @param conn - RLS-scoped {@link Conn} from an active `withUserContext` frame.
 * @returns The header, or null when the project is missing.
 */
export async function getProjectHeader(
  projectId: string,
  conn: Conn,
): Promise<ProjectHeader | null> {
  const [row] = await conn
    .select({
      title: projects.title,
      description: projects.description,
      identifier: projects.identifier,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

/**
 * A task's parent-project header (plus the project id) as a lazy batch
 * statement keyed on the task id, so it can ride the same batch as the
 * task read. The id column lets the context bundle derive the ancestor
 * chain from this row without a separate query.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the task whose parent project to read.
 * @param withDescription - Whether to select the project `description`
 *   column. Only bundles that render a Project Context section (planning,
 *   review, record) read it; the working/summary paths pass false and pay
 *   no text egress (the column stays type-stable as an empty literal).
 * @returns Lazy select yielding zero or one header rows.
 */
export function projectHeaderByTaskStmt(
  read: ReadConn,
  taskId: string,
  withDescription: boolean,
) {
  return read
    .select({
      id: projects.id,
      title: projects.title,
      description: withDescription
        ? projects.description
        : sql<string>`''`.as("description"),
      identifier: projects.identifier,
    })
    .from(projects)
    .innerJoin(tasks, eq(tasks.projectId, projects.id))
    .where(eq(tasks.id, taskId))
    .limit(1);
}

// ---------------------------------------------------------------------------
// Tag aggregation
// ---------------------------------------------------------------------------

/** Project tag with usage count. */
export type ProjectTag = { tag: string; count: number };

/**
 * Aggregate distinct tags for a project with usage counts.
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Tags sorted by count desc, tie-broken alphabetically.
 */
export async function getProjectTags(
  ctx: AuthContext,
  projectId: string,
): Promise<ProjectTag[]> {
  return withUserContext(ctx.userId, (tx) => getProjectTagsTx(tx, projectId));
}

/**
 * Read a project's category vocabulary, lifecycle status, and identifier
 * in one RLS-scoped read. Status and identifier ride along so the category
 * mutations can gate on the archived phase without a second query.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns The vocabulary array (possibly empty), project status, and identifier.
 * @throws ForbiddenError when the project is not visible to the caller.
 */
export async function getProjectCategories(
  ctx: AuthContext,
  projectId: string,
): Promise<{
  categories: string[];
  status: ProjectStatus;
  identifier: string;
}> {
  const [rows] = await withUserContextRead(ctx.userId, (read) => [
    read
      .select({
        categories: projects.categories,
        status: projects.status,
        identifier: projects.identifier,
      })
      .from(projects)
      .where(eq(projects.id, projectId)),
  ]);
  const row = rows[0];
  if (!row) throw new ForbiddenError("Forbidden", "project", projectId);
  return row;
}

/**
 * {@link getProjectTags} on a caller-supplied tx.
 *
 * @param tx - Active RLS transaction handle.
 * @param projectId - UUID of the project.
 * @returns Sorted tag vocabulary with usage counts.
 */
export async function getProjectTagsTx(
  tx: Tx,
  projectId: string,
): Promise<ProjectTag[]> {
  await assertProjectAccessTx(tx, projectId);
  return aggregateProjectTags(tx, projectId);
}

/**
 * Project tag vocabulary over one read batch.
 *
 * UNCHECKED: performs no authorization — callers must have gated the
 * project (e.g. via `getSearchProjectGate`). RLS still scopes the
 * aggregated task rows, so an unauthorized caller gets an empty
 * vocabulary, never another tenant's tags.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param projectId - UUID of the project.
 * @returns Tags sorted by count desc, tie-broken alphabetically.
 */
export async function fetchProjectTagsRead(
  userId: string,
  projectId: string,
): Promise<ProjectTag[]> {
  const [raw] = await withUserContextRead(userId, (read) => [
    projectTagsStmt(read, projectId),
  ]);
  return mapProjectTagRows(
    normalizeExecuteResult<{ tag: string; count: number | string }>(raw),
  );
}

// ---------------------------------------------------------------------------
// Project metadata (slim — no tasks, no edges)
// ---------------------------------------------------------------------------

/**
 * Slim project-level metadata for agent orientation. Intended as the
 * lightweight alternative to {@link buildProjectOverview} when the agent
 * needs categories, tag vocab, or progress without dragging every task and
 * edge into context. Three queries: project header (via assertProjectAccessTx),
 * tag aggregation, and status-grouped count.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Project metadata with category list, tag vocab, and task stats.
 * @throws ForbiddenError on missing or cross-team project.
 */
export async function getProjectMeta(
  ctx: AuthContext,
  projectId: string,
): Promise<ProjectMeta> {
  return withUserContext(ctx.userId, async (tx) => {
    const { project } = await assertProjectAccessTx(tx, projectId);

    const [tagVocabulary, statusCounts] = await Promise.all([
      aggregateProjectTags(tx, projectId),
      tx
        .select({
          status: tasks.status,
          count: sql<number>`count(*)::int`.as("count"),
        })
        .from(tasks)
        .where(eq(tasks.projectId, projectId))
        .groupBy(tasks.status),
    ]);

    const taskStats = emptyTaskStats();
    for (const c of statusCounts) {
      accumulateTaskStats(taskStats, c.status, c.count);
    }
    const denominator = taskStats.total - taskStats.cancelled;
    const progress =
      denominator > 0 ? Math.round((taskStats.done / denominator) * 100) : 0;

    return {
      id: project.id,
      identifier: project.identifier,
      title: project.title,
      description: project.description,
      status: project.status,
      categories: project.categories,
      tagVocabulary,
      taskStats,
      progress,
    };
  });
}

// ---------------------------------------------------------------------------
// Team list
// ---------------------------------------------------------------------------

/** Team entry returned by {@link listUserTeams}. */
export type UserTeamEntry = {
  /** Team UUID — pass to `piyaz_workspace action='create' organizationId='...'`. */
  id: string;
  /** Display name shown in the home grid and settings. */
  name: string;
  /** URL-friendly slug. */
  slug: string;
  /** Caller's `member.role` (owner / admin / member). */
  role: string;
  /** Number of projects in this team the caller has access to. */
  projectCount: number;
};

/**
 * Fetch every team the caller belongs to, decorated with the caller's role
 * and a project count. Sorted by membership creation order so the team the
 * caller joined first surfaces first — matches the session-init heuristic
 * in `lib/auth.ts` and gives stable ordering across repeated calls.
 *
 * Empty teams (no projects) are included — that's the entire point of this
 * action; `listProjectsSlim` skips them.
 *
 * Per-org project counts use `inArray` even though RLS already scopes
 * `projects` to the caller's accessible orgs — the explicit list narrows
 * the index scan.
 *
 * @param ctx - Resolved auth context.
 * @returns Array of teams with role and project counts.
 */
export async function listUserTeams(
  ctx: AuthContext,
): Promise<UserTeamEntry[]> {
  return withUserContext(ctx.userId, async (tx) => {
    const orgRows = await executeRaw<{
      org_id: string;
      name: string;
      slug: string;
      member_role: string;
    }>(
      tx,
      sql`SELECT org_id, name, slug, member_role FROM public.current_user_orgs()`,
    );

    if (orgRows.length === 0) return [];

    const counts = await tx
      .select({
        organizationId: projects.organizationId,
        total: sql<number>`count(*)::int`.as("total"),
      })
      .from(projects)
      .where(
        inArray(
          projects.organizationId,
          orgRows.map((r) => r.org_id),
        ),
      )
      .groupBy(projects.organizationId);

    const countByOrg = new Map(counts.map((c) => [c.organizationId, c.total]));

    return orgRows.map((r) => ({
      id: r.org_id,
      name: r.name,
      slug: r.slug,
      role: r.member_role,
      projectCount: countByOrg.get(r.org_id) ?? 0,
    }));
  });
}

// ---------------------------------------------------------------------------
// Project list
// ---------------------------------------------------------------------------

/** Page of slim project entries with a cursor to fetch the next slice. */
export type ProjectSlimPage = {
  rows: ProjectListEntry[];
  nextCursor: Cursor | null;
};

/**
 * Paginated home-grid project list. Keyset pagination on
 * `(projects.updated_at DESC, projects.id DESC)` so concurrent
 * inserts/updates don't shift later pages. Membership is the access
 * boundary; the home grid surfaces work across every team without a
 * per-session "active" filter.
 *
 * @param ctx - Resolved auth context.
 * @param opts - Pagination options. `limit` defaults to 15, capped at 100.
 *   `cursor` is the opaque token from a previous page's `nextCursor`.
 * @returns Page of project entries plus the cursor for the next page (or
 *   `null` when the page is the last one).
 */
export async function listProjectsSlim(
  ctx: AuthContext,
  opts: { limit?: number; cursor?: Cursor | string | null } = {},
): Promise<ProjectSlimPage> {
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 100);
  const after = decodeCursor(opts.cursor);

  // The cursor stores `updated_at` at millisecond precision (JS `Date` → ISO)
  // while Postgres `timestamptz` keeps microseconds. Compare and order on the
  // same millisecond-truncated key so rows sharing a millisecond across a page
  // boundary are neither skipped nor duplicated.
  const afterIso = after?.updatedAt.toISOString();
  const updatedAtMs = sql`date_trunc('milliseconds', ${projects.updatedAt})`;
  const cursorClause = after
    ? sql`(${updatedAtMs} < ${afterIso}::timestamptz
            OR (${updatedAtMs} = ${afterIso}::timestamptz AND ${projects.id} < ${after.id}))`
    : sql`TRUE`;

  return withUserContext(ctx.userId, async (tx) => {
    const [orgRows, trimmedAll] = await Promise.all([
      executeRaw<{
        org_id: string;
        name: string;
        slug: string;
        member_role: string;
      }>(
        tx,
        sql`SELECT org_id, name, slug, member_role FROM public.current_user_orgs()`,
      ),
      tx
        .select({
          id: projects.id,
          organizationId: projects.organizationId,
          title: projects.title,
          identifier: projects.identifier,
          description: projects.description,
          status: projects.status,
          updatedAt: projects.updatedAt,
        })
        .from(projects)
        .where(cursorClause)
        .orderBy(desc(updatedAtMs), desc(projects.id))
        .limit(limit + 1),
    ]);

    const orgsById = new Map(
      orgRows
        .map((r) => ({
          id: r.org_id,
          name: r.name,
          slug: r.slug,
          memberRole: r.member_role,
        }))
        .map((o) => [o.id, o]),
    );

    const hasMore = trimmedAll.length > limit;
    const trimmed = hasMore ? trimmedAll.slice(0, limit) : trimmedAll;
    const last = trimmed[trimmed.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            updatedAt: new Date(last.updatedAt),
            id: last.id,
          })
        : null;

    if (trimmed.length === 0) return { rows: [], nextCursor: null };

    const projectIds = trimmed.map((p) => p.id);
    const counts = await tx
      .select({
        projectId: tasks.projectId,
        status: tasks.status,
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(tasks)
      .where(sql`${tasks.projectId} IN ${projectIds}`)
      .groupBy(tasks.projectId, tasks.status);

    const statsByProject = new Map<string, ProjectTaskStats>();
    for (const c of counts) {
      const stats = statsByProject.get(c.projectId) ?? emptyTaskStats();
      accumulateTaskStats(stats, c.status, c.count);
      statsByProject.set(c.projectId, stats);
    }

    const rows: ProjectListEntry[] = trimmed.map((project) => {
      const org = orgsById.get(project.organizationId);
      if (!org) {
        throw new Error(
          `listProjectsSlim: project ${project.id} has no matching org in current_user_orgs()`,
        );
      }
      const taskStats = statsByProject.get(project.id) ?? emptyTaskStats();
      const denominator = taskStats.total - taskStats.cancelled;
      return {
        ...project,
        organization: { id: org.id, name: org.name, slug: org.slug },
        memberRole: org.memberRole,
        taskStats,
        progress:
          denominator > 0
            ? Math.round((taskStats.done / denominator) * 100)
            : 0,
      };
    });

    return { rows, nextCursor };
  });
}

/**
 * Hard cap on the command-palette project index — far beyond any realistic
 * per-user project count, so the slim payload stays bounded while still
 * covering every accessible project for ⌘K jump-to.
 */
const PROJECT_INDEX_CAP = 1000;

/**
 * Minimal project nav list for the ⌘K command palette. Selects only the four
 * columns jump-to renders (id, organizationId, title, identifier) — no task
 * stats, joins, or timestamps — so the caller's entire accessible set fits in
 * one slim payload, fetched once when the palette first opens. RLS scopes the
 * rows to the caller's memberships. Ordered `updatedAt DESC, id DESC` so
 * recent work leads; capped at {@link PROJECT_INDEX_CAP}.
 *
 * @param ctx - Resolved auth context.
 * @returns Slim project nav rows, newest first.
 */
export async function listProjectIndex(
  ctx: AuthContext,
): Promise<ProjectIndexEntry[]> {
  return withUserContext(ctx.userId, async (tx) =>
    tx
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        title: projects.title,
        identifier: projects.identifier,
      })
      .from(projects)
      .orderBy(desc(projects.updatedAt), desc(projects.id))
      .limit(PROJECT_INDEX_CAP),
  );
}

/**
 * Lean project list for the MCP `piyaz_workspace action='projects'` tool. Selects
 * only the columns the agent skill consumes (id, organizationId, title,
 * identifier, status) plus the team chip and rolled-up task counts, and
 * skips the heavy `description`, `categories`, and timestamp
 * columns at the SQL projection so wire bytes are saved off the Postgres
 * round-trip — not just trimmed in JS. Agents fetch description and tag
 * vocabulary on demand via `piyaz_get project view='meta'`.
 *
 * No pagination; returns every project the caller can see, ordered by
 * `updatedAt DESC, id DESC` to match `listProjectsSlim`.
 *
 * @param ctx - Resolved auth context.
 * @returns Slim project entries with team metadata and task stats.
 */
export async function listProjectsForMcp(
  ctx: AuthContext,
): Promise<ProjectListEntryMcp[]> {
  return withUserContext(ctx.userId, async (tx) => {
    const [orgRows, projectRows] = await Promise.all([
      executeRaw<{
        org_id: string;
        name: string;
        slug: string;
        member_role: string;
      }>(
        tx,
        sql`SELECT org_id, name, slug, member_role FROM public.current_user_orgs()`,
      ),
      tx
        .select({
          id: projects.id,
          organizationId: projects.organizationId,
          title: projects.title,
          identifier: projects.identifier,
          status: projects.status,
        })
        .from(projects)
        .orderBy(desc(projects.updatedAt), desc(projects.id)),
    ]);

    if (projectRows.length === 0) return [];

    const orgsById = new Map(
      orgRows.map((r) => [
        r.org_id,
        {
          id: r.org_id,
          name: r.name,
          slug: r.slug,
          memberRole: r.member_role,
        },
      ]),
    );

    const projectIds = projectRows.map((r) => r.id);
    const counts = await tx
      .select({
        projectId: tasks.projectId,
        status: tasks.status,
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(tasks)
      .where(sql`${tasks.projectId} IN ${projectIds}`)
      .groupBy(tasks.projectId, tasks.status);

    const statsByProject = new Map<string, ProjectTaskStats>();
    for (const c of counts) {
      const stats = statsByProject.get(c.projectId) ?? emptyTaskStats();
      accumulateTaskStats(stats, c.status, c.count);
      statsByProject.set(c.projectId, stats);
    }

    return projectRows.map((row) => {
      const org = orgsById.get(row.organizationId);
      if (!org) {
        throw new Error(
          `listProjectsForMcp: project ${row.id} has no matching org in current_user_orgs()`,
        );
      }
      const taskStats = statsByProject.get(row.id) ?? emptyTaskStats();
      const denominator = taskStats.total - taskStats.cancelled;
      return {
        id: row.id,
        organizationId: row.organizationId,
        title: row.title,
        identifier: row.identifier,
        status: row.status,
        organization: { id: org.id, name: org.name, slug: org.slug },
        memberRole: org.memberRole,
        taskStats,
        progress:
          denominator > 0
            ? Math.round((taskStats.done / denominator) * 100)
            : 0,
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Project mutations
// ---------------------------------------------------------------------------

/**
 * Input for createProject — identifier optional. `organizationId` is
 * optional only when the caller is a member of exactly one team. Multi-team
 * callers must name the target explicitly; see {@link createProject}.
 */
export type CreateProjectInput = Omit<
  typeof projects.$inferInsert,
  "id" | "identifier" | "organizationId"
> & {
  identifier?: Identifier;
  /**
   * Target team. Required when the caller is a member of more than one
   * team. Membership in the supplied team is verified before insert.
   */
  organizationId?: string;
};

/**
 * Pick an identifier that's not already taken within an organization,
 * auto-suffixing on collision. Identifiers are unique per organization
 * (composite constraint `projects_org_identifier_unique`), so the scan
 * is scoped to the supplied team — two teams can independently use the
 * same prefix.
 *
 * Must be called inside a transaction holding the identifier advisory
 * lock; otherwise the select-then-insert window is racy.
 *
 * @param tx - Drizzle transaction handle.
 * @param organizationId - UUID of the organization the project belongs to.
 * @param base - Starting identifier (e.g. derived from title).
 * @returns Unique identifier within the organization.
 * @throws If no unique variant found within 1000 attempts.
 */
async function pickAvailableIdentifier(
  tx: Tx,
  organizationId: string,
  base: Identifier,
): Promise<Identifier> {
  const existing = await tx
    .select({ identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.organizationId, organizationId));
  const taken = new Set(existing.map((r) => r.identifier));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = String(i);
    const candidate = base.slice(0, 12 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate as Identifier;
  }
  throw new IdentifierAllocationError(base);
}

/**
 * Resolve the destination team for a `createProject` call inside an
 * existing transaction frame.
 *
 * Resolution rules — every path enforces a fresh membership check, so a
 * stale token cannot write into a team the user has been removed from:
 *
 * 1. `requested` provided → membership-checked; on miss raise
 *    `ForbiddenError`.
 * 2. Omitted + caller has exactly one membership → use that team.
 * 3. Omitted + caller has multiple memberships → raise
 *    {@link MultiTeamAmbiguityError} carrying the team list so the
 *    tool-handler can surface the choice to the agent.
 * 4. Omitted + caller has zero memberships → raise
 *    {@link NoTeamMembershipError}.
 *
 * @param tx - Active RLS transaction frame whose GUC already binds the
 *   caller; membership is read via `public.current_user_orgs()`.
 * @param _ctx - Resolved auth context (currently unused — kept for parity
 *   with the public `createProject` signature should a future check need
 *   non-user fields).
 * @param requested - Optional explicit `organizationId` from the caller.
 * @returns Verified destination team UUID.
 * @throws ForbiddenError when `requested` is supplied but the caller is
 *   not a member of that team.
 * @throws MultiTeamAmbiguityError when omitted and the caller is in >1 team.
 * @throws NoTeamMembershipError when omitted and the caller has no teams.
 */
async function resolveTargetOrgIdInTx(
  tx: Tx,
  _ctx: AuthContext,
  requested: string | undefined,
): Promise<string> {
  const memberships = await executeRaw<{ org_id: string; name: string }>(
    tx,
    sql`SELECT org_id, name FROM public.current_user_orgs()`,
  );

  if (requested !== undefined) {
    if (!isUuid(requested)) {
      throw new ForbiddenError("Forbidden", "team", requested);
    }
    if (!memberships.some((m) => m.org_id === requested)) {
      throw new ForbiddenError("Forbidden", "team", requested);
    }
    return requested;
  }

  if (memberships.length === 0) throw new NoTeamMembershipError();
  if (memberships.length === 1) return memberships[0].org_id;
  const teams: TeamOption[] = memberships.map((m) => ({
    id: m.org_id,
    name: m.name,
  }));
  throw new MultiTeamAmbiguityError(teams);
}

/**
 * Insert a new project. Destination resolution and the insert run in a
 * single `withUserContext` frame — one `set_config` round-trip, and the
 * membership check shares the transaction snapshot with the insert so
 * membership cannot be revoked between checks.
 *
 * If `identifier` is omitted, it is derived from the title and auto-suffixed
 * on collision under a transaction-scoped advisory lock keyed on the target
 * team. If provided, collision surfaces the DB unique-violation error.
 *
 * @param ctx - Resolved auth context.
 * @param data - Project fields. `identifier` optional. `organizationId`
 *   required when the caller is a member of more than one team.
 * @returns The created project row.
 * @throws ForbiddenError when `data.organizationId` is supplied but the
 *   caller is not a member of that team.
 * @throws MultiTeamAmbiguityError when omitted and the caller is in >1 team.
 * @throws NoTeamMembershipError when omitted and the caller has no teams.
 */
export async function createProject(
  ctx: AuthContext,
  data: CreateProjectInput,
) {
  if (typeof data.description === "string" && data.description.trim()) {
    data = {
      ...data,
      description: (await formatMarkdown(data.description)) ?? data.description,
    };
  }

  const { project, targetOrgId } = await withUserContext(
    ctx.userId,
    async (tx) => {
      const targetOrgId = await resolveTargetOrgIdInTx(
        tx,
        ctx,
        data.organizationId,
      );

      let identifier = data.identifier;
      if (identifier === undefined) {
        await acquireOrgIdentifierLock(tx, targetOrgId);
        identifier = await pickAvailableIdentifier(
          tx,
          targetOrgId,
          deriveIdentifier(data.title),
        );
      }

      const [row] = await tx
        .insert(projects)
        .values({
          ...data,
          identifier,
          organizationId: targetOrgId,
        })
        .returning();

      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId: row.id,
          taskId: null,
          type: "project_created",
          summary: `created project "${row.title}"`,
        },
      ]);

      return { project: row, targetOrgId };
    },
  );

  await emitProjectListEvent(targetOrgId);
  return project;
}

/** Fields an `updateProject` caller is allowed to change. `identifier`
 * is intentionally excluded — renames must go through
 * {@link renameProjectIdentifier} so they hold the per-org advisory lock. */
export type ProjectUpdate = Partial<
  Pick<
    typeof projects.$inferInsert,
    "title" | "description" | "status" | "categories"
  >
>;

/** Fields callers must not change via `updateProject` — managed internally
 * (timestamps, id), tenant-scoped (organizationId), or gated by a
 * separate API (identifier → renameProjectIdentifier). Stripped at runtime
 * from the input object before the spread to defeat mass-assignment via
 * untyped or `as any` callers. */
const PROTECTED_PROJECT_FIELDS = [
  "id",
  "organizationId",
  "identifier",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Update a project's fields. Intentionally NOT role-gated for the
 * member-editable subset (title, description, categories, status); only
 * `delete` and identifier `rename` require admin/owner, and those gates
 * live on {@link deleteProject} and {@link renameProjectIdentifier}.
 *
 * Defense in depth: the {@link ProjectUpdate} type erases at runtime, so
 * this function additionally rejects `changes.identifier` with
 * {@link InsufficientRoleError} (callers must use
 * {@link renameProjectIdentifier}) and strips every key in
 * {@link PROTECTED_PROJECT_FIELDS} before forwarding to Drizzle.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param changes - Typed subset of project fields to update.
 * @returns The updated project row plus `priorStatus`, the lifecycle phase
 *   before this update (for the MCP transition hints).
 * @throws {InsufficientRoleError} If `changes.identifier` is set.
 */
export async function updateProject(
  ctx: AuthContext,
  projectId: string,
  changes: ProjectUpdate,
) {
  const incoming = changes as Record<string, unknown>;
  if (incoming.identifier !== undefined) {
    throw new InsufficientRoleError(["rename"], "project", projectId);
  }
  const safe: Record<string, unknown> = { ...incoming };
  for (const key of PROTECTED_PROJECT_FIELDS) {
    if (key in safe) delete safe[key];
  }

  if (typeof safe.description === "string" && safe.description.trim()) {
    const formatted = await formatMarkdown(safe.description);
    safe.description = formatted ?? safe.description;
  }
  const updated = await withUserContext(ctx.userId, async (tx) => {
    const access = await assertProjectAccessTx(tx, projectId);
    // Every editable field (title, description, status, categories) ships
    // in the slim payload's project block, so the metadata clock always
    // moves with the content clock here. No touch trigger fires on the
    // projects row itself, so the GREATEST floor (the trigger idiom)
    // keeps the meta clock monotonic under app/DB clock skew.
    const [row] = await tx
      .update(projects)
      .set({
        ...safe,
        updatedAt: new Date(),
        metaUpdatedAt: sql`GREATEST(meta_updated_at, now())`,
      })
      .where(eq(projects.id, projectId))
      .returning();
    return { ...row, priorStatus: access.project.status };
  });
  emitProjectEvent(projectId);
  return updated;
}

/**
 * Delete a project and all its children (cascade via DB foreign keys).
 * Requires the caller's active-org role to grant `project:delete` (admin or
 * owner); plain members trigger {@link InsufficientRoleError}.
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project to delete.
 */
export async function deleteProject(ctx: AuthContext, projectId: string) {
  const organizationId = await withUserContext(ctx.userId, async (tx) => {
    const { project } = await assertProjectAccessTx(tx, projectId, {
      project: ["delete"],
    });
    await tx.delete(projects).where(eq(projects.id, projectId));
    return project.organizationId;
  });
  await emitProjectDeleted(projectId, organizationId);
}

/**
 * Rename a project's identifier under the per-org identifier advisory lock.
 *
 * Holding the org-scoped lock serializes this rename with concurrent
 * `createProject` auto-suffix allocation in the same org, closing the
 * select-then-insert window. The composite unique constraint
 * `projects_org_identifier_unique` still surfaces a `23505` if the target
 * is already taken inside this org by a project outside the lock-protected
 * critical section (e.g. a direct SQL rename).
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project to rename.
 * @param identifier - New identifier (already shape-validated).
 * @returns The updated project row.
 * @throws {ProjectNotFoundError} If no project matches `projectId`.
 */
export async function renameProjectIdentifier(
  ctx: AuthContext,
  projectId: string,
  identifier: Identifier,
) {
  const updated = await withUserContext(ctx.userId, async (tx) => {
    const { project } = await assertProjectAccessTx(tx, projectId, {
      project: ["rename"],
    });
    await acquireOrgIdentifierLock(tx, project.organizationId);
    // Every taskRef and noteRef in the slim payload derives from the
    // identifier at read time, so a rename is slim-visible without
    // touching a single task row. GREATEST keeps the meta clock
    // monotonic: no touch trigger fires on the projects row itself.
    const [row] = await tx
      .update(projects)
      .set({
        identifier,
        updatedAt: new Date(),
        metaUpdatedAt: sql`GREATEST(meta_updated_at, now())`,
      })
      .where(eq(projects.id, projectId))
      .returning();
    if (!row) throw new ProjectNotFoundError(projectId);
    return row;
  });
  emitProjectEvent(projectId);
  return updated;
}

// ---------------------------------------------------------------------------
// Category operations (transactional)
// ---------------------------------------------------------------------------

/**
 * Rename a project category and update all tasks that reference it.
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param oldName - Current category name.
 * @param newName - New category name.
 */
export async function renameCategory(
  ctx: AuthContext,
  projectId: string,
  oldName: string,
  newName: string,
) {
  await withUserContext(ctx.userId, async (tx) => {
    await assertProjectAccessTx(tx, projectId);
    const [project] = await tx
      .select({ categories: projects.categories })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new ProjectNotFoundError(projectId);

    const updatedCategories = project.categories.map((c) =>
      c === oldName ? newName : c,
    );
    await tx
      .update(projects)
      .set({
        categories: updatedCategories,
        updatedAt: new Date(),
        metaUpdatedAt: sql`GREATEST(meta_updated_at, now())`,
      })
      .where(eq(projects.id, projectId));

    // Category is slim-visible; stamping the task rows' meta clock in the
    // same bulk statement keeps the trigger propagation consistent, and
    // the GREATEST floor keeps every clock monotonic under skew.
    await tx
      .update(tasks)
      .set({
        category: newName,
        updatedAt: new Date(),
        metaUpdatedAt: sql`GREATEST(meta_updated_at, now())`,
      })
      .where(and(eq(tasks.projectId, projectId), eq(tasks.category, oldName)));
  });
  emitProjectEvent(projectId);
}

/**
 * Delete a project category and uncategorize all tasks in it.
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param categoryName - Category to remove.
 */
export async function deleteCategory(
  ctx: AuthContext,
  projectId: string,
  categoryName: string,
) {
  await withUserContext(ctx.userId, async (tx) => {
    await assertProjectAccessTx(tx, projectId);
    const [project] = await tx
      .select({ categories: projects.categories })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw new ProjectNotFoundError(projectId);

    const updatedCategories = project.categories.filter(
      (c) => c !== categoryName,
    );
    await tx
      .update(projects)
      .set({
        categories: updatedCategories,
        updatedAt: new Date(),
        metaUpdatedAt: sql`GREATEST(meta_updated_at, now())`,
      })
      .where(eq(projects.id, projectId));

    await tx
      .update(tasks)
      .set({
        category: null,
        updatedAt: new Date(),
        metaUpdatedAt: sql`GREATEST(meta_updated_at, now())`,
      })
      .where(
        and(eq(tasks.projectId, projectId), eq(tasks.category, categoryName)),
      );
  });
  emitProjectEvent(projectId);
}
