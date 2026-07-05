import type {
  InfiniteData,
  QueryClient,
  QueryFunctionContext,
} from "@tanstack/react-query";
import {
  conditionalFetch,
  conditionalFetchPage,
} from "@/lib/query/conditional-fetch";
import { noteKeys, projectKeys, taskKeys } from "@/lib/query/keys";
import type { BundleKind, BundlePart } from "@/lib/context/parts";
import type {
  NoteFullResult,
  NoteSearchHit,
  NoteTreeRow,
  TaskNoteBacklink,
} from "@/lib/data/note";
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

/**
 * QueryFn factory for a project's slim notes tree list.
 *
 * @param qc - QueryClient.
 * @param projectId - Project id.
 * @returns Conditional-GET fetcher.
 */
export function fetchNotesTree(
  qc: QueryClient,
  projectId: string,
): Fn<NoteTreeRow[]> {
  return (ctx) =>
    conditionalFetch<NoteTreeRow[]>({
      url: `/api/project/${projectId}/notes`,
      queryKey: noteKeys.list(projectId),
      queryClient: qc,
      signal: ctx.signal,
    });
}

/**
 * QueryFn factory for a single full note with its link context.
 *
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param noteId - Note id.
 * @returns Conditional-GET fetcher.
 */
export function fetchNoteDetail(
  qc: QueryClient,
  projectId: string,
  noteId: string,
): Fn<NoteFullResult> {
  return (ctx) =>
    conditionalFetch<NoteFullResult>({
      url: `/api/note/${noteId}`,
      queryKey: noteKeys.detail(projectId, noteId),
      queryClient: qc,
      signal: ctx.signal,
    });
}

/**
 * QueryFn factory for a task's linked-note backlinks.
 *
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param taskId - Task id.
 * @returns Conditional-GET fetcher.
 */
export function fetchNoteBacklinks(
  qc: QueryClient,
  projectId: string,
  taskId: string,
): Fn<TaskNoteBacklink[]> {
  return (ctx) =>
    conditionalFetch<TaskNoteBacklink[]>({
      url: `/api/task/${taskId}/notes`,
      queryKey: noteKeys.backlinks(projectId, taskId),
      queryClient: qc,
      signal: ctx.signal,
    });
}

/**
 * QueryFn factory for ranked note search hits. Plain GET: the search route
 * ships no conditional-GET validator by design, so this never rides the
 * ETag side-channel.
 *
 * @param projectId - Project id.
 * @param q - Search query string; callers gate empty queries with `enabled`.
 * @returns Plain fetcher.
 */
export function fetchNoteSearch(
  projectId: string,
  q: string,
): Fn<NoteSearchHit[]> {
  return async (ctx) => {
    const res = await fetch(
      `/api/project/${projectId}/notes/search?q=${encodeURIComponent(q)}`,
      { signal: ctx.signal, credentials: "same-origin", cache: "no-store" },
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as NoteSearchHit[];
  };
}
