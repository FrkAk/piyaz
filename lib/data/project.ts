import "server-only";

import { and, asc, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { serviceRoleDb } from "@/lib/db";
import { executeRaw, type Conn } from "@/lib/db/raw";
import { withUserContext, type Tx } from "@/lib/db/rls";
import { projects, tasks, taskEdges } from "@/lib/db/schema";
import {
  assigneeCountExpr,
  assigneeUserIdsExpr,
  hasCriteriaExpr,
} from "@/lib/data/task";
import { slimEdgeColumns } from "@/lib/data/edge-columns";
import { acquireOrgIdentifierLock } from "@/lib/db/raw/acquire-org-identifier-lock";
import { aggregateProjectTags } from "@/lib/db/raw/aggregate-project-tags";
import { getProjectListMaxUpdatedAtRaw } from "@/lib/db/raw/get-project-list-max-updated-at";
import { getProjectMaxUpdatedAtRaw } from "@/lib/db/raw/get-project-max-updated-at";
import type { HistoryEntry } from "@/lib/types";
import {
  asIdentifier,
  deriveIdentifier,
  enrichWithTaskRef,
  type Identifier,
} from "@/lib/graph/identifier";
import type {
  ProjectChrome,
  ProjectGraphSlim,
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
} from "@/lib/auth/authorization";
import {
  emitProjectDeleted,
  emitProjectEvent,
  emitProjectListEvent,
} from "@/lib/realtime/events";
import { decodeCursor, encodeCursor, type Cursor } from "@/lib/data/cursor";

/**
 * Build a timestamped history entry.
 * @param entry - Partial entry without id/date.
 * @returns Complete history entry with generated id and current date.
 */
function makeHistoryEntry(
  entry: Omit<HistoryEntry, "id" | "date">,
): HistoryEntry {
  return {
    ...entry,
    id: crypto.randomUUID(),
    date: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Single-entity queries
// ---------------------------------------------------------------------------

/**
 * Slim graph payload for the workspace canvas + task list. Drops the heavy
 * task fields (description, plan, decisions, criteria, executionRecord)
 * that only the per-task detail surface needs — those are fetched lazily
 * via `GET /api/task/[id]`.
 *
 * Two column-projected selects run under `Promise.all`. The edges select
 * filters on `source_task_id` alone: the `task_edges_same_project_immutable`
 * trigger guarantees both endpoints share a project, so the source-side
 * index scan returns every intra-project edge exactly once — no second arm
 * or de-dupe needed.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Slim project metadata + slim tasks + slim edges.
 * @throws ForbiddenError on missing or cross-team project.
 */
export async function getProjectGraphSlim(
  ctx: AuthContext,
  projectId: string,
): Promise<ProjectGraphSlim> {
  return withUserContext(ctx.userId, async (tx) => {
    const { project } = await assertProjectAccessTx(tx, projectId);

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
        updatedAt: tasks.updatedAt,
        sequenceNumber: tasks.sequenceNumber,
        hasDescription: sql<boolean>`length(btrim(${tasks.description})) > 0`,
        hasCriteria: hasCriteriaExpr(),
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

    const [taskRows, edges] = await Promise.all([tasksQ, edgesQ]);
    const enriched = enrichWithTaskRef(
      taskRows,
      asIdentifier(project.identifier),
    );

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
        status: project.status,
        updatedAt: project.updatedAt,
        categories: project.categories,
      },
      tasks: slimTasks,
      edges,
    };
  });
}

/**
 * Chrome data for the workspace layout: project header, caller role,
 * owning team, and total task count.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Chrome view of the project.
 * @throws ForbiddenError on missing or cross-team project.
 */
export async function getProjectChrome(
  ctx: AuthContext,
  projectId: string,
): Promise<ProjectChrome> {
  return withUserContext(ctx.userId, async (tx) => {
    const {
      project,
      memberRole,
      organization: org,
    } = await assertProjectAccessTx(tx, projectId);

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
 * Latest `updated_at` across the project, its tasks, and its edges. Used
 * by the conditional-GET path on the workspace graph endpoint to short-
 * circuit the heavy slim-graph read on a 304 response.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns The latest timestamp.
 * @throws ForbiddenError on missing or cross-team project.
 */
export async function getProjectMaxUpdatedAt(
  ctx: AuthContext,
  projectId: string,
): Promise<Date> {
  return withUserContext(ctx.userId, async (tx) => {
    await assertProjectAccessTx(tx, projectId);
    const max = await getProjectMaxUpdatedAtRaw(tx, projectId);
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

    const taskStats: ProjectTaskStats = {
      total: 0,
      done: 0,
      inProgress: 0,
      cancelled: 0,
    };
    for (const c of statusCounts) {
      taskStats.total += c.count;
      if (c.status === "done") taskStats.done = c.count;
      else if (c.status === "in_progress") taskStats.inProgress = c.count;
      else if (c.status === "cancelled") taskStats.cancelled = c.count;
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
  /** Team UUID — pass to `mymir_project create organizationId='...'`. */
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
 * @param opts - Pagination options. `limit` defaults to 50, capped at 100.
 *   `cursor` is the opaque token from a previous page's `nextCursor`.
 * @returns Page of project entries plus the cursor for the next page (or
 *   `null` when the page is the last one).
 */
export async function listProjectsSlim(
  ctx: AuthContext,
  opts: { limit?: number; cursor?: Cursor | string | null } = {},
): Promise<ProjectSlimPage> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const after = decodeCursor(opts.cursor);

  const afterIso = after?.updatedAt.toISOString();
  const cursorClause = after
    ? sql`(${projects.updatedAt} < ${afterIso}::timestamptz
            OR (${projects.updatedAt} = ${afterIso}::timestamptz AND ${projects.id} < ${after.id}))`
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
        .select(getTableColumns(projects))
        .from(projects)
        .where(cursorClause)
        .orderBy(desc(projects.updatedAt), desc(projects.id))
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
      const stats = statsByProject.get(c.projectId) ?? {
        total: 0,
        done: 0,
        inProgress: 0,
        cancelled: 0,
      };
      stats.total += c.count;
      if (c.status === "done") stats.done = c.count;
      else if (c.status === "in_progress") stats.inProgress = c.count;
      else if (c.status === "cancelled") stats.cancelled = c.count;
      statsByProject.set(c.projectId, stats);
    }

    const rows: ProjectListEntry[] = trimmed.map((project) => {
      const org = orgsById.get(project.organizationId);
      if (!org) {
        throw new Error(
          `listProjectsSlim: project ${project.id} has no matching org in current_user_orgs()`,
        );
      }
      const taskStats = statsByProject.get(project.id) ?? {
        total: 0,
        done: 0,
        inProgress: 0,
        cancelled: 0,
      };
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
 * Lean project list for the MCP `mymir_project action='list'` tool. Selects
 * only the columns the agent skill consumes (id, organizationId, title,
 * identifier, status) plus the team chip and rolled-up task counts, and
 * skips the heavy `description`, `history`, `categories`, and timestamp
 * columns at the SQL projection so wire bytes are saved off the Postgres
 * round-trip — not just trimmed in JS. Agents fetch description and tag
 * vocabulary on demand via `mymir_query type='meta'`.
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
      const stats = statsByProject.get(c.projectId) ?? {
        total: 0,
        done: 0,
        inProgress: 0,
        cancelled: 0,
      };
      stats.total += c.count;
      if (c.status === "done") stats.done = c.count;
      else if (c.status === "in_progress") stats.inProgress = c.count;
      else if (c.status === "cancelled") stats.cancelled = c.count;
      statsByProject.set(c.projectId, stats);
    }

    return projectRows.map((row) => {
      const org = orgsById.get(row.organizationId);
      if (!org) {
        throw new Error(
          `listProjectsForMcp: project ${row.id} has no matching org in current_user_orgs()`,
        );
      }
      const taskStats = statsByProject.get(row.id) ?? {
        total: 0,
        done: 0,
        inProgress: 0,
        cancelled: 0,
      };
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
          history: [
            makeHistoryEntry({
              type: "created",
              label: "Project created",
              description: `Project "${data.title}" created.`,
              actor: "user",
            }),
          ],
        })
        .returning();
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
 * (history, timestamps, id), tenant-scoped (organizationId), or gated by a
 * separate API (identifier → renameProjectIdentifier). Stripped at runtime
 * from the input object before the spread to defeat mass-assignment via
 * untyped or `as any` callers. */
const PROTECTED_PROJECT_FIELDS = [
  "id",
  "organizationId",
  "identifier",
  "history",
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
 * @returns The updated project row.
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
    await assertProjectAccessTx(tx, projectId);
    const [row] = await tx
      .update(projects)
      .set({ ...safe, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();
    return row;
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
    const [row] = await tx
      .update(projects)
      .set({ identifier, updatedAt: new Date() })
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
      .set({ categories: updatedCategories, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    await tx
      .update(tasks)
      .set({ category: newName, updatedAt: new Date() })
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
      .set({ categories: updatedCategories, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    await tx
      .update(tasks)
      .set({ category: null, updatedAt: new Date() })
      .where(
        and(eq(tasks.projectId, projectId), eq(tasks.category, categoryName)),
      );
  });
  emitProjectEvent(projectId);
}
