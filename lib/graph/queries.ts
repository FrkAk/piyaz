"use server";

import { requireLegalConsent } from "@/lib/auth/consent";
import { getAuthContext } from "@/lib/auth/context";
import { getSession } from "@/lib/auth/session";
import { checkActionRateLimit } from "@/lib/actions/rate-limit-action";
import {
  getProjectChrome as coreGetProjectChrome,
  getProjectGraphSlim as coreGetProjectGraphSlim,
  listProjectsSlim as coreListProjectsSlim,
  listProjectIndex as coreListProjectIndex,
} from "@/lib/data/project";
import {
  searchTasksAcrossProjects as coreSearchTasksAcrossProjects,
  listMyTasks as coreListMyTasks,
  type CrossProjectSearchResult,
} from "@/lib/data/task";
import {
  searchNotesAcrossProjects as coreSearchNotesAcrossProjects,
  type CrossProjectNoteSearchResult,
} from "@/lib/data/note";
import { loadProjectAccess } from "@/lib/auth/authorization";
import type { MyTask, ProjectIndexEntry } from "@/lib/data/views";

export type {
  TaskSlim,
  TaskState,
  SearchResult,
  CrossProjectSearchResult,
} from "@/lib/data/task";
export type { MyTask } from "@/lib/data/views";
export type { CrossProjectNoteSearchResult } from "@/lib/data/note";
export type { DetailedEdge } from "@/lib/data/edge";
export type { ProjectTag } from "@/lib/data/project";
export type {
  ProjectChrome,
  ProjectGraphSlim,
  ProjectIndexEntry,
  ProjectListEntry,
  ProjectListOrganization,
} from "@/lib/data/views";

/** Closed set of failure codes for `searchPaletteAcrossProjects`. */
export type CrossProjectSearchFailureCode =
  | "unauthorized"
  | "rate_limited"
  | "unknown";

/** Discriminated result for the combined command-palette search action. */
export type CrossProjectPaletteSearchPayload =
  | {
      ok: true;
      tasks: CrossProjectSearchResult[];
      notes: CrossProjectNoteSearchResult[];
    }
  | { ok: false; code: CrossProjectSearchFailureCode };

export type MyTasksListFailureCode =
  | "unauthorized"
  | "rate_limited"
  | "unknown";

export type MyTasksListResultPayload =
  | { ok: true; rows: MyTask[] }
  | { ok: false; code: MyTasksListFailureCode };

/** Closed set of failure codes for `listProjectIndex`. */
export type ProjectIndexFailureCode =
  | "unauthorized"
  | "rate_limited"
  | "unknown";

/** Discriminated result for the command-palette project-index server action. */
export type ProjectIndexResultPayload =
  | { ok: true; rows: ProjectIndexEntry[] }
  | { ok: false; code: ProjectIndexFailureCode };

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
  await requireLegalConsent(ctx.userId);
  const access = await loadProjectAccess(ctx.userId, projectId);
  return coreGetProjectChrome(ctx, projectId, access);
}

/**
 * Server action wrapper — fetches the first keyset page of projects across
 * every team the caller is a member of, decorated with team metadata, the
 * caller's role, and progress stats. Seeds both the sidebar list and the
 * home grid's infinite query.
 * @returns First page `{ rows, nextCursor }` ordered by `updatedAt` descending.
 */
export async function listProjectsSlim() {
  const ctx = await getAuthContext();
  await requireLegalConsent(ctx.userId);
  return coreListProjectsSlim(ctx);
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
  await requireLegalConsent(ctx.userId);
  const access = await loadProjectAccess(ctx.userId, projectId);
  return coreGetProjectGraphSlim(ctx, projectId, access);
}

/**
 * Server action wrapper — combined cross-project task + note search for the
 * global ⌘K palette. One rate-limit charge against the `search.cross-project`
 * slot and one auth resolution cover both searches, which run in parallel on
 * the server. Throttled at 60/min per-user and 90/min per-IP; unauth callers
 * throttle by IP only.
 *
 * @param query - Search string (taskRef, title, tag, project title / identifier).
 * @returns `{ ok: true, tasks, notes }` or a typed failure.
 */
export async function searchPaletteAcrossProjects(
  query: string,
): Promise<CrossProjectPaletteSearchPayload> {
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
  await requireLegalConsent(userId);

  try {
    const ctx = await getAuthContext();
    const [tasks, notes] = await Promise.all([
      coreSearchTasksAcrossProjects(ctx, query),
      coreSearchNotesAcrossProjects(ctx, query),
    ]);
    return { ok: true, tasks, notes };
  } catch (err) {
    console.error("searchPaletteAcrossProjects failed", err);
    return { ok: false, code: "unknown" };
  }
}

/**
 * Server action wrapper — full slim project index for the ⌘K palette's
 * project jump-to. Returns every project the caller can reach (capped in the
 * data layer), not just the paginated sidebar window, so the palette never
 * silently hides a project. Fetched once when the palette first opens.
 * Throttled at 30/min per-user and 60/min per-IP via the shared `actions`
 * slot; unauth callers throttle by IP only.
 *
 * @returns `{ ok: true, rows }` newest-first, or a typed failure.
 */
export async function listProjectIndex(): Promise<ProjectIndexResultPayload> {
  // Resolve user id before the rate-limit check so authed callers throttle
  // per-user, not per-IP (IP keys collide on shared NATs).
  const session = await getSession();
  const userId = session?.user.id ?? null;

  const limit = await checkActionRateLimit(
    {
      action: "palette.project-index",
      windowSeconds: 60,
      perUserMax: 30,
      perIpMax: 60,
    },
    userId,
  );
  if (!limit.ok) return { ok: false, code: "rate_limited" };

  if (!userId) return { ok: false, code: "unauthorized" };
  await requireLegalConsent(userId);

  try {
    const ctx = await getAuthContext();
    const rows = await coreListProjectIndex(ctx);
    return { ok: true, rows };
  } catch (err) {
    console.error("listProjectIndex failed", err);
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
  await requireLegalConsent(userId);

  try {
    const ctx = await getAuthContext();
    const rows = await coreListMyTasks(ctx);
    return { ok: true, rows };
  } catch (err) {
    console.error("listMyTasks failed", err);
    return { ok: false, code: "unknown" };
  }
}
