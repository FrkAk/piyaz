"use server";

import { getAuthContext } from "@/lib/auth/context";
import { getSession } from "@/lib/auth/session";
import { checkActionRateLimit } from "@/lib/actions/rate-limit-action";
import {
  getProjectChrome as coreGetProjectChrome,
  getProjectGraphSlim as coreGetProjectGraphSlim,
  listProjectsSlim as coreListProjectsSlim,
} from "@/lib/data/project";
import {
  searchTasksAcrossProjects as coreSearchTasksAcrossProjects,
  listMyTasks as coreListMyTasks,
  type CrossProjectSearchResult,
} from "@/lib/data/task";
import type { MyTask } from "@/lib/data/views";

export type {
  TaskSlim,
  TaskState,
  SearchResult,
  CrossProjectSearchResult,
} from "@/lib/data/task";
export type { LifecycleStage, MyTask } from "@/lib/data/views";
export type { DetailedEdge } from "@/lib/data/edge";
export type { ProjectTag } from "@/lib/data/project";
export type {
  ProjectChrome,
  ProjectGraphSlim,
  ProjectListEntry,
  ProjectListOrganization,
} from "@/lib/data/views";

/** Closed set of failure codes for `searchTasksAcrossProjects`. */
export type CrossProjectSearchFailureCode =
  | "unauthorized"
  | "rate_limited"
  | "unknown";

/** Discriminated result for the command-palette server action. */
export type CrossProjectSearchResultPayload =
  | { ok: true; rows: CrossProjectSearchResult[] }
  | { ok: false; code: CrossProjectSearchFailureCode };

export type MyTasksListFailureCode =
  | "unauthorized"
  | "rate_limited"
  | "unknown";

export type MyTasksListResultPayload =
  | { ok: true; rows: MyTask[] }
  | { ok: false; code: MyTasksListFailureCode };

/**
 * Server action wrapper — fetches the chrome view of a project (header
 * fields plus owning team, caller's role, and a task count) for the
 * workspace layout. The project must belong to a team the caller is a
 * member of; cross-team probes raise a `ForbiddenError`.
 * @param projectId - UUID of the project.
 * @returns Chrome view of the project.
 */
export async function getProjectChrome(projectId: string) {
  const ctx = await getAuthContext();
  return coreGetProjectChrome(ctx, projectId);
}

/**
 * Server action wrapper — fetches every project across every team the
 * caller is a member of, decorated with team metadata, the caller's role,
 * and progress stats.
 * @returns Array of projects ordered by `updatedAt` descending.
 */
export async function listProjectsSlim() {
  const ctx = await getAuthContext();
  const { rows } = await coreListProjectsSlim(ctx);
  return rows;
}

/**
 * Server action wrapper — fetches the slim graph for a project (project
 * chrome fields, slim task rows, full edges). Membership-gated; cross-team
 * probes raise a `ForbiddenError`.
 *
 * @param projectId - UUID of the project.
 * @returns Slim project graph for the workspace canvas + list.
 */
export async function getProjectGraphSlim(projectId: string) {
  const ctx = await getAuthContext();
  return coreGetProjectGraphSlim(ctx, projectId);
}

/**
 * Server action wrapper — cross-project task search for the global ⌘K
 * palette. Throttled at 60/min per-user and 90/min per-IP via the shared
 * `actions` slot; unauth callers throttle by IP only.
 *
 * @param query - Search string (full or partial taskRef, title / tag / project / sequence number).
 * @returns `{ ok: true, rows }` or a typed failure.
 */
export async function searchTasksAcrossProjects(
  query: string,
): Promise<CrossProjectSearchResultPayload> {
  // Resolve user id before the rate-limit check so authed callers throttle
  // per-user, not per-IP (IP keys collide on shared NATs).
  const session = await getSession();
  const userId = session?.user.id ?? null;

  const limit = await checkActionRateLimit(
    {
      action: "search.cross-project",
      windowSeconds: 60,
      perUserMax: 60,
      perIpMax: 90,
    },
    userId,
  );
  if (!limit.ok) return { ok: false, code: "rate_limited" };

  if (!userId) return { ok: false, code: "unauthorized" };

  try {
    const ctx = await getAuthContext();
    const rows = await coreSearchTasksAcrossProjects(ctx, query);
    return { ok: true, rows };
  } catch (err) {
    console.error("searchTasksAcrossProjects failed", err);
    return { ok: false, code: "unknown" };
  }
}

export async function listMyTasks(): Promise<MyTasksListResultPayload> {
  // Resolve user id first so authed callers throttle per-user, not per-IP
  // (IP keys collide on shared NATs).
  const session = await getSession();
  const userId = session?.user.id ?? null;

  const limit = await checkActionRateLimit(
    {
      action: "my-tasks.list",
      windowSeconds: 60,
      perUserMax: 30,
      perIpMax: 60,
    },
    userId,
  );
  if (!limit.ok) return { ok: false, code: "rate_limited" };

  if (!userId) return { ok: false, code: "unauthorized" };

  try {
    const ctx = await getAuthContext();
    const rows = await coreListMyTasks(ctx);
    return { ok: true, rows };
  } catch (err) {
    console.error("listMyTasks failed", err);
    return { ok: false, code: "unknown" };
  }
}
