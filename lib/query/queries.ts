import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query";
import {
  conditionalFetch,
  conditionalFetchPage,
} from "@/lib/query/conditional-fetch";
import { projectKeys, taskKeys } from "@/lib/query/keys";
import type {
  ProjectGraphSlim,
  ProjectListEntry,
  TaskFullWithEdges,
} from "@/lib/data/views";

/** Three-bundle markdown payload returned by `/api/task/[id]/context`. */
export type TaskContextBundles = {
  agent: string;
  planning: string;
  working: string;
};

type Fn<T> = (ctx: QueryFunctionContext<readonly unknown[]>) => Promise<T>;

/**
 * One keyset page of the home-grid project list. `nextCursor` is the opaque
 * token to request the following page, or `null` at the end of the list.
 */
export type ProjectListPage = {
  rows: ProjectListEntry[];
  nextCursor: string | null;
};

/**
 * QueryFn factory for one page of the home-grid project list. Conditional-GET
 * per page (side-channel ETag keyed by cursor), so an unchanged page costs a
 * bodiless 304 and skips the server-side stats roll-up.
 *
 * @param qc - QueryClient (closed over so the 304 branch can read cache).
 * @returns Page fetcher suitable for `useInfiniteQuery({ queryFn })`.
 */
export function fetchProjectsPage(
  qc: QueryClient,
): (
  ctx: QueryFunctionContext<readonly unknown[], string | null>,
) => Promise<ProjectListPage> {
  return (ctx) =>
    conditionalFetchPage<ProjectListPage>({
      url: ctx.pageParam
        ? `/api/projects?cursor=${encodeURIComponent(ctx.pageParam)}`
        : "/api/projects",
      queryKey: projectKeys.list(),
      pageParam: ctx.pageParam,
      queryClient: qc,
      signal: ctx.signal,
    });
}

/**
 * QueryFn factory for a project's slim graph.
 *
 * @param qc - QueryClient.
 * @param projectId - Project id.
 * @returns Conditional-GET fetcher.
 */
export function fetchProjectGraph(
  qc: QueryClient,
  projectId: string,
): Fn<ProjectGraphSlim> {
  return (ctx) =>
    conditionalFetch<ProjectGraphSlim>({
      url: `/api/project/${projectId}/graph`,
      queryKey: projectKeys.graph(projectId),
      queryClient: qc,
      signal: ctx.signal,
    });
}

/**
 * QueryFn factory for a single full task body.
 *
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param taskId - Task id.
 * @returns Conditional-GET fetcher.
 */
export function fetchTaskBody(
  qc: QueryClient,
  projectId: string,
  taskId: string,
): Fn<TaskFullWithEdges> {
  return (ctx) =>
    conditionalFetch<TaskFullWithEdges>({
      url: `/api/task/${taskId}`,
      queryKey: taskKeys.detail(projectId, taskId),
      queryClient: qc,
      signal: ctx.signal,
    });
}

/**
 * QueryFn factory for a task's three-bundle markdown payload.
 *
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param taskId - Task id.
 * @returns Conditional-GET fetcher.
 */
export function fetchTaskContext(
  qc: QueryClient,
  projectId: string,
  taskId: string,
): Fn<TaskContextBundles> {
  return (ctx) =>
    conditionalFetch<TaskContextBundles>({
      url: `/api/task/${taskId}/context`,
      queryKey: taskKeys.context(projectId, taskId),
      queryClient: qc,
      signal: ctx.signal,
    });
}
