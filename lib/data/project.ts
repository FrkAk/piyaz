import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, tasks, taskEdges } from "@/lib/db/schema";
import { member, organization } from "@/lib/db/auth-schema";
import { acquireOrgIdentifierLock } from "@/lib/db/raw/acquire-org-identifier-lock";
import { aggregateProjectTags } from "@/lib/db/raw/aggregate-project-tags";
import type { HistoryEntry } from "@/lib/types";
import { deriveIdentifier, type Identifier } from "@/lib/graph/identifier";
import {
  IdentifierAllocationError,
  MultiTeamAmbiguityError,
  NoTeamMembershipError,
  ProjectNotFoundError,
  type TeamOption,
} from "@/lib/graph/errors";
import { formatMarkdown } from "@/lib/markdown/format";
import type { AuthContext } from "@/lib/auth/context";
import {
  ForbiddenError,
  InsufficientRoleError,
  assertProjectAccess,
  isUuid,
} from "@/lib/auth/authorization";
import { dbEvents } from "@/lib/events";
import type { ProjectFull, ProjectSlim, ProjectListEntry } from "@/lib/data/views";
import { decodeCursor, encodeCursor, type Cursor } from "@/lib/data/cursor";

/** Emit a change event to all connected SSE clients via the in-memory event bus. */
function notifyChange() {
  dbEvents.emit("change", "*");
}

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
 * Fetch a project with its tasks, edges, and owning team, scoped to the
 * caller's memberships. The organization is projected from the same JOIN
 * inside `assertProjectAccess` — no separate round-trip.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Project with flat tasks, edges, owning team metadata, and the caller's role.
 * @throws ForbiddenError when the project is cross-team.
 */
export async function getProjectFull(
  ctx: AuthContext,
  projectId: string,
): Promise<ProjectFull> {
  const { project, memberRole, organization: org } = await assertProjectAccess(projectId, ctx);

  const projectTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.order));

  const taskIds = projectTasks.map((t) => t.id);
  let edges: (typeof taskEdges.$inferSelect)[] = [];
  if (taskIds.length > 0) {
    edges = await db
      .select()
      .from(taskEdges)
      .where(
        or(
          sql`${taskEdges.sourceTaskId} IN ${taskIds}`,
          sql`${taskEdges.targetTaskId} IN ${taskIds}`,
        ),
      );
  }

  return {
    ...project,
    tasks: projectTasks,
    edges,
    memberRole,
    organization: org,
  };
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
 * @returns The identifier string, or null when the project is missing.
 */
export async function getProjectIdentifier(
  projectId: string,
): Promise<string | null> {
  const [row] = await db
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
 * @returns The header, or null when the project is missing.
 */
export async function getProjectHeader(
  projectId: string,
): Promise<ProjectHeader | null> {
  const [row] = await db
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
  await assertProjectAccess(projectId, ctx);
  return aggregateProjectTags(db, projectId);
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
 * @param ctx - Resolved auth context.
 * @returns Array of teams with role and project counts.
 */
export async function listUserTeams(
  ctx: AuthContext,
): Promise<UserTeamEntry[]> {
  const memberships = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, ctx.userId))
    .orderBy(asc(member.createdAt));

  if (memberships.length === 0) return [];

  const counts = await db
    .select({
      organizationId: projects.organizationId,
      total: sql<number>`count(*)::int`.as("total"),
    })
    .from(projects)
    .where(
      inArray(
        projects.organizationId,
        memberships.map((m) => m.id),
      ),
    )
    .groupBy(projects.organizationId);

  const countByOrg = new Map(counts.map((c) => [c.organizationId, c.total]));

  return memberships.map((m) => ({
    id: m.id,
    name: m.name,
    slug: m.slug,
    role: m.role,
    projectCount: countByOrg.get(m.id) ?? 0,
  }));
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

  const rawRows = await db
    .select({
      project: getTableColumns(projects),
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      },
      memberRole: member.role,
    })
    .from(projects)
    .innerJoin(
      member,
      and(
        eq(member.organizationId, projects.organizationId),
        eq(member.userId, ctx.userId),
      ),
    )
    .innerJoin(organization, eq(organization.id, projects.organizationId))
    .where(cursorClause)
    .orderBy(desc(projects.updatedAt), desc(projects.id))
    .limit(limit + 1);

  const hasMore = rawRows.length > limit;
  const trimmed = hasMore ? rawRows.slice(0, limit) : rawRows;
  const last = trimmed[trimmed.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          updatedAt: new Date(last.project.updatedAt),
          id: last.project.id,
        })
      : null;

  if (trimmed.length === 0) return { rows: [], nextCursor: null };

  const projectIds = trimmed.map((p) => p.project.id);
  const allTasks = await db
    .select({ status: tasks.status, projectId: tasks.projectId })
    .from(tasks)
    .where(sql`${tasks.projectId} IN ${projectIds}`);

  const tasksByProject = new Map<string, { status: string }[]>();
  for (const t of allTasks) {
    const list = tasksByProject.get(t.projectId) ?? [];
    list.push({ status: t.status });
    tasksByProject.set(t.projectId, list);
  }

  const rows: ProjectListEntry[] = trimmed.map(
    ({ project, organization: org, memberRole }) => {
      const projTasks = tasksByProject.get(project.id) ?? [];
      const cancelled = projTasks.filter((t) => t.status === "cancelled").length;
      const taskStats = {
        total: projTasks.length,
        done: projTasks.filter((t) => t.status === "done").length,
        inProgress: projTasks.filter((t) => t.status === "in_progress").length,
        cancelled,
      };
      const denominator = taskStats.total - cancelled;

      return {
        ...project,
        organization: org,
        memberRole,
        taskStats,
        progress:
          denominator > 0
            ? Math.round((taskStats.done / denominator) * 100)
            : 0,
      };
    },
  );

  return { rows, nextCursor };
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
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
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
 * Resolve the destination team for a `createProject` call.
 *
 * Resolution rules — every path enforces a fresh membership check, so a
 * stale token cannot write into a team the user has been removed from:
 *
 * 1. `data.organizationId` provided → membership-checked; on miss raise
 *    `ForbiddenError`.
 * 2. Omitted + caller has exactly one membership → use that team.
 * 3. Omitted + caller has multiple memberships → raise
 *    {@link MultiTeamAmbiguityError} carrying the team list so the
 *    tool-handler can surface the choice to the agent.
 * 4. Omitted + caller has zero memberships → raise
 *    {@link NoTeamMembershipError}.
 *
 * @param ctx - Resolved auth context.
 * @param requested - Optional explicit `organizationId` from the caller.
 * @returns Verified destination team UUID.
 */
async function resolveTargetOrgId(
  ctx: AuthContext,
  requested: string | undefined,
): Promise<string> {
  if (requested !== undefined) {
    if (!isUuid(requested)) {
      throw new ForbiddenError("Forbidden", "team", requested);
    }
    const [row] = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(eq(member.userId, ctx.userId), eq(member.organizationId, requested)),
      )
      .limit(1);
    if (!row) throw new ForbiddenError("Forbidden", "team", requested);
    return requested;
  }

  const memberships = await db
    .select({ id: organization.id, name: organization.name })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, ctx.userId));

  if (memberships.length === 0) throw new NoTeamMembershipError();
  if (memberships.length === 1) return memberships[0].id;
  const teams: TeamOption[] = memberships.map((m) => ({ id: m.id, name: m.name }));
  throw new MultiTeamAmbiguityError(teams);
}

/**
 * Insert a new project. Destination resolution is handled by
 * {@link resolveTargetOrgId} (always membership-checked).
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
  const targetOrgId = await resolveTargetOrgId(ctx, data.organizationId);

  if (typeof data.description === "string" && data.description.trim()) {
    data = {
      ...data,
      description: (await formatMarkdown(data.description)) ?? data.description,
    };
  }
  const project = await db.transaction(async (tx) => {
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
    return row;
  });
  notifyChange();
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
  await assertProjectAccess(projectId, ctx);

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
  const [updated] = await db
    .update(projects)
    .set({ ...safe, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning();
  notifyChange();
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
  await assertProjectAccess(projectId, ctx, { project: ["delete"] });
  await db.delete(projects).where(eq(projects.id, projectId));
  notifyChange();
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
  const { project } = await assertProjectAccess(projectId, ctx, {
    project: ["rename"],
  });

  const updated = await db.transaction(async (tx) => {
    await acquireOrgIdentifierLock(tx, project.organizationId);
    const [row] = await tx
      .update(projects)
      .set({ identifier, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();
    if (!row) throw new ProjectNotFoundError(projectId);
    return row;
  });
  notifyChange();
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
  await assertProjectAccess(projectId, ctx);

  await db.transaction(async (tx) => {
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
      .where(
        and(eq(tasks.projectId, projectId), eq(tasks.category, oldName)),
      );
  });
  notifyChange();
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
  await assertProjectAccess(projectId, ctx);

  await db.transaction(async (tx) => {
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
  notifyChange();
}
