"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type { SidebarProject } from "@/components/layout/Sidebar";
import type { ProjectListEntry } from "@/lib/data/views";
import type { ProjectListPage } from "@/lib/query/queries";

/** Shared sidebar project list with on-demand keyset pagination. */
interface SidebarProjectsValue {
  /** Projects loaded so far, newest first. */
  projects: SidebarProject[];
  /** Whether another keyset page is available. */
  hasMore: boolean;
  /** Whether a page fetch is currently in flight. */
  isLoadingMore: boolean;
  /** True when the last {@link loadMore} failed — the cursor is retained so the next call retries. */
  error: boolean;
  /** Fetch and append the next keyset page. No-op when exhausted or already loading. */
  loadMore: () => void;
  /** Drop a project from the list — keeps the sidebar in sync after a delete. */
  removeProject: (id: string) => void;
}

const SidebarProjectsContext = createContext<SidebarProjectsValue | null>(null);

interface SidebarProjectsProviderProps {
  /** First keyset page, rendered server-side by AppShell. */
  initialProjects: SidebarProject[];
  /** Cursor for the second page, or `null` when the first page is the last. */
  initialCursor: string | null;
  /** Subtree that reads the list via {@link useSidebarProjects}. */
  children: ReactNode;
}

/**
 * Project list shared by the desktop sidebar, the mobile drawer, and the
 * command palette. Holds a single growing list seeded from AppShell's first
 * server-rendered page and appends one keyset page per {@link loadMore} call,
 * so navigation reaches every project without fetching the whole list up
 * front. The keyset endpoint is the same `/api/projects` the home grid uses.
 *
 * @param props - Initial page, initial cursor, and subtree.
 * @returns Context provider over the growing project list.
 */
export function SidebarProjectsProvider({
  initialProjects,
  initialCursor,
  children,
}: SidebarProjectsProviderProps) {
  const [projects, setProjects] = useState(initialProjects);
  const [cursor, setCursor] = useState(initialCursor);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const loadMore = useCallback(() => {
    if (!cursor || isLoadingMore) return;
    setIsLoadingMore(true);
    setError(false);
    void (async () => {
      try {
        const res = await fetch(
          `/api/projects?cursor=${encodeURIComponent(cursor)}`,
          { credentials: "same-origin", cache: "no-store" },
        );
        if (!res.ok) {
          setError(true);
          return;
        }
        const page = (await res.json()) as ProjectListPage;
        setProjects((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          const added = page.rows
            .filter((row) => !seen.has(row.id))
            .map(toSidebarProject);
          return added.length > 0 ? [...prev, ...added] : prev;
        });
        setCursor(page.nextCursor);
      } catch {
        setError(true);
      } finally {
        setIsLoadingMore(false);
      }
    })();
  }, [cursor, isLoadingMore]);

  const removeProject = useCallback((id: string) => {
    setProjects((prev) => {
      const next = prev.filter((p) => p.id !== id);
      return next.length === prev.length ? prev : next;
    });
  }, []);

  return (
    <SidebarProjectsContext
      value={{
        projects,
        hasMore: cursor !== null,
        isLoadingMore,
        error,
        loadMore,
        removeProject,
      }}
    >
      {children}
    </SidebarProjectsContext>
  );
}

/**
 * Project the `/api/projects` row onto the slim shape the sidebar renders.
 *
 * @param row - Full list entry from the keyset endpoint.
 * @returns Sidebar project (id, identifier, title, owning team).
 */
function toSidebarProject(row: ProjectListEntry): SidebarProject {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    organizationId: row.organizationId,
  };
}

/**
 * Read the shared sidebar project list. Falls back to an empty, inert list
 * outside the provider so components referenced on unauthenticated routes —
 * which never mount AppShell — don't crash.
 *
 * @returns Project list plus the show-more controls.
 */
export function useSidebarProjects(): SidebarProjectsValue {
  const ctx = useContext(SidebarProjectsContext);
  if (ctx) return ctx;
  return {
    projects: [],
    hasMore: false,
    isLoadingMore: false,
    error: false,
    loadMore: () => {},
    removeProject: () => {},
  };
}
