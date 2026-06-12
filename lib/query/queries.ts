import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query";
import { conditionalFetch } from "@/lib/query/conditional-fetch";
import { projectKeys, taskKeys } from "@/lib/query/keys";
import type { BundleKind, BundlePart } from "@/lib/context/parts";
import type {
  ProjectGraphSlim,
  ProjectListEntry,
  TaskFullWithEdges,
} from "@/lib/data/views";

/** Structured sections payload returned by `/api/task/[id]/context?bundle=`. */
export type TaskContextSections = {
  sections: BundlePart[];
};

type Fn<T> = (ctx: QueryFunctionContext<readonly unknown[]>) => Promise<T>;

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
 * QueryFn factory for one bundle kind's structured sections.
 *
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param taskId - Task id.
 * @param kind - Bundle kind to fetch.
 * @returns Conditional-GET fetcher.
 */
export function fetchTaskContext(
  qc: QueryClient,
  projectId: string,
  taskId: string,
  kind: BundleKind,
): Fn<TaskContextSections> {
  return (ctx) =>
    conditionalFetch<TaskContextSections>({
      url: `/api/task/${taskId}/context?bundle=${kind}`,
      queryKey: taskKeys.context(projectId, taskId, kind),
      queryClient: qc,
      signal: ctx.signal,
    });
}
