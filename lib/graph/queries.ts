"use server";

import { getAuthContext } from "@/lib/auth/context";
import {
  getProjectChrome as coreGetProjectChrome,
  getProjectGraphSlim as coreGetProjectGraphSlim,
  listProjectsSlim as coreListProjectsSlim,
} from "@/lib/data/project";
import { searchTasksAcrossProjects as coreSearchTasksAcrossProjects } from "@/lib/data/task";

export type {
  TaskSlim,
  TaskState,
  SearchResult,
  CrossProjectSearchResult,
} from "@/lib/data/task";
export type { DetailedEdge } from "@/lib/data/edge";
export type { ProjectTag } from "@/lib/data/project";
export type {
  ProjectChrome,
  ProjectGraphSlim,
  ProjectListEntry,
  ProjectListOrganization,
} from "@/lib/data/views";

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
 * Server action wrapper — searches tasks across every project the caller
 * is a member of. Constrained to `current_user_orgs()`; returns up to 10
 * rows by default. Used by the global ⌘K command palette.
 *
 * @param query - Search string (taskRef, title, or tag substring).
 * @returns Matching tasks with project crumb metadata.
 */
export async function searchTasksAcrossProjects(query: string) {
  const ctx = await getAuthContext();
  return coreSearchTasksAcrossProjects(ctx, query);
}
