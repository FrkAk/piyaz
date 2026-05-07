"use server";

import { getAuthContext } from "@/lib/auth/context";
import {
  getProjectFull as coreGetProjectFull,
  listProjectsSlim as coreListProjectsSlim,
} from "@/lib/data/project";

export type { TaskSlim, TaskState, SearchResult } from "@/lib/data/task";
export type { DetailedEdge } from "@/lib/data/edge";
export type { ProjectTag } from "@/lib/data/project";
export type { ProjectListEntry, ProjectListOrganization } from "@/lib/data/views";

/**
 * Server action wrapper — fetches a project with tasks and edges. The
 * project must belong to a team the caller is a member of; cross-team
 * probes raise a `ForbiddenError`.
 * @param projectId - UUID of the project.
 * @returns Project with flat tasks and edges.
 */
export async function getProjectFull(projectId: string) {
  const ctx = await getAuthContext();
  return coreGetProjectFull(ctx, projectId);
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
