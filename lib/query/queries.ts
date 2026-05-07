import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query";
import { conditionalFetch } from "@/lib/query/conditional-fetch";
import { projectKeys, taskKeys } from "@/lib/query/keys";
import type {
  ProjectGraphSlim,
  ProjectListEntry,
  TaskFull,
} from "@/lib/data/views";

/** Three-bundle markdown payload returned by `/api/task/[id]/context`. */
export type TaskContextBundles = {
  agent: string;
  planning: string;
  working: string;
};

type Fn<T> = (
  ctx: QueryFunctionContext<readonly unknown[]>,
) => Promise<T>;

/**
 * QueryFn factory for the home-grid project list.
 *
 * @param qc - QueryClient (closed over so the 304 branch can read cache).
 * @returns Conditional-GET fetcher suitable for `useQuery({ queryFn })`.
 */
export function fetchProjectsList(qc: QueryClient): Fn<ProjectListEntry[]> {
  return (ctx) =>
    conditionalFetch<ProjectListEntry[]>({
      url: "/api/projects",
      queryKey: projectKeys.list(),
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
): Fn<TaskFull> {
  return (ctx) =>
    conditionalFetch<TaskFull>({
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
