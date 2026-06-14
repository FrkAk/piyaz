import type {
  InfiniteData,
  QueryClient,
  QueryFunctionContext,
} from "@tanstack/react-query";
import {
  conditionalFetch,
  conditionalFetchPage,
} from "@/lib/query/conditional-fetch";
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
 * One keyset page of the home-grid project list. `nextCursor` is the opaque
 * token to request the following page, or `null` at the end of the list.
 */
export type ProjectListPage = {
  rows: ProjectListEntry[];
  nextCursor: string | null;
};

/**
 * Drop a project from the cached infinite home-grid list, preserving page
 * params. Used to optimistically remove a deleted card: the list ETag is a
 * max-`updated_at` validator that can't observe a deletion, so a plain
 * invalidation would 304 and resurrect the stale page.
 *
 * @param data - Cached infinite data, or `undefined` when the list isn't cached.
 * @param projectId - Id of the project to remove.
 * @returns New infinite data without the project; the same reference when the
 *   project was not present (no needless re-render).
 */
export function removeProjectFromList(
  data: InfiniteData<ProjectListPage> | undefined,
  projectId: string,
): InfiniteData<ProjectListPage> | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    if (!page.rows.some((row) => row.id === projectId)) return page;
    changed = true;
    return { ...page, rows: page.rows.filter((row) => row.id !== projectId) };
  });
  return changed ? { ...data, pages } : data;
}

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
