"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/providers/SessionProvider";
import type { TaskState } from "@/lib/data/task";
import type { MyTask } from "@/lib/data/views";
import {
  listMyTasks,
  type MyTasksListFailureCode,
} from "@/lib/graph/queries";
import { myTasksKeys } from "@/lib/query/keys";
import { STATUS_META } from "@/components/shared/StatusGlyph";
import {
  ActiveFilters,
  type ActiveFilterChip,
} from "./ActiveFilters";
import { ErrorBanner } from "./ErrorBanner";
import { MyTasksEmpty } from "./MyTasksEmpty";
import { MyTasksFooter } from "./MyTasksFooter";
import { MyTasksHeader } from "./MyTasksHeader";
import { MyTasksList } from "./MyTasksList";
import { MyTasksToolbar } from "./MyTasksToolbar";
import { NoMatch } from "./NoMatch";
import { PickupBanner } from "./PickupBanner";
import { SavedViewsTabs } from "./SavedViewsTabs";
import {
  SAVED_VIEWS,
  SAVED_VIEW_LABEL,
  countByState,
  groupByState,
  matchesSearch,
  pickPickupTask,
  type SavedView,
  viewPredicate,
} from "./predicates";

const VIEW_HOTKEYS: Record<string, SavedView> = {
  "1": "open",
  "2": "today",
  "3": "stale",
  "4": "done",
  "5": "all",
};

const VALID_STATUS_FILTERS: ReadonlySet<TaskState> = new Set<TaskState>([
  "in_progress",
  "in_review",
  "blocked",
  "ready",
  "plannable",
  "draft",
  "done",
  "cancelled",
]);

interface MyTasksClientProps {
  /**
   * Failure code from the RSC prefetch when the server-side load returned
   * `!ok`. Surfaces as an inline banner above the header; the rest of the
   * chrome still hydrates so the user can read pre-fetched chrome rather
   * than seeing a blank page.
   */
  initialError?: MyTasksListFailureCode | null;
}

/**
 * Top-level interactive client for `/my-tasks`. Owns the URL-persisted
 * filter state (view, status, search), the local collapse state for the
 * `done` group, and the keyboard hotkey map. Renders every page surface
 * documented in DESIGN.md by composing the smaller sub-components.
 *
 * @param props - Optional SSR prefetch failure code.
 * @returns The full `/my-tasks` page body.
 */
export function MyTasksClient({ initialError = null }: MyTasksClientProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? "/my-tasks";
  const session = useAuth();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const view = parseView(searchParams.get("view"));
  const statusFilter = parseStatus(searchParams.get("status"));
  const query = searchParams.get("q") ?? "";

  const [collapsedDone, setCollapsedDone] = useState(true);

  const { data, error } = useQuery<MyTask[]>({
    queryKey: myTasksKeys.list(),
    queryFn: async () => {
      const payload = await listMyTasks();
      if (!payload.ok) throw new Error(payload.code);
      return payload.rows;
    },
  });

  const rows = data ?? EMPTY_ROWS;
  const isFullyEmpty = rows.length === 0 && initialError === null && !error;

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const setView = useCallback(
    (next: SavedView) => {
      updateParams((p) => {
        if (next === "open") p.delete("view");
        else p.set("view", next);
        p.delete("status");
      });
    },
    [updateParams],
  );

  const setStatusFilter = useCallback(
    (next: TaskState | null) => {
      updateParams((p) => {
        if (next === null) p.delete("status");
        else p.set("status", next);
      });
    },
    [updateParams],
  );

  const toggleStatus = useCallback(
    (next: TaskState) => {
      setStatusFilter(statusFilter === next ? null : next);
    },
    [statusFilter, setStatusFilter],
  );

  const setQuery = useCallback(
    (next: string) => {
      updateParams((p) => {
        if (next.length === 0) p.delete("q");
        else p.set("q", next);
      });
    },
    [updateParams],
  );

  const now = useMemo(() => new Date(), []);

  const viewRows = useMemo(
    () => rows.filter((r) => viewPredicate(view, r, now)),
    [rows, view, now],
  );

  const viewCounts = useMemo(() => countByState(viewRows), [viewRows]);

  const filteredRows = useMemo(() => {
    let list: MyTask[] = viewRows;
    if (statusFilter) list = list.filter((r) => r.state === statusFilter);
    if (query.trim()) list = list.filter((r) => matchesSearch(r, query));
    return list;
  }, [viewRows, statusFilter, query]);

  const groups = useMemo(() => groupByState(filteredRows), [filteredRows]);

  const pickupTask = useMemo(() => pickPickupTask(rows), [rows]);

  const viewCountsByKey = useMemo(() => {
    const out = {} as Record<SavedView, number>;
    for (const v of SAVED_VIEWS) {
      out[v] = rows.filter((r) => viewPredicate(v, r, now)).length;
    }
    return out;
  }, [rows, now]);

  const activeChips = useMemo<ActiveFilterChip[]>(() => {
    const chips: ActiveFilterChip[] = [];
    if (view !== "open" && view !== "all") {
      chips.push({
        id: "view",
        key: "View",
        value: SAVED_VIEW_LABEL[view],
        tone: "var(--color-accent)",
      });
    }
    if (statusFilter) {
      chips.push({
        id: "status",
        key: "Status",
        value: STATUS_META[statusFilter].label,
        tone: STATUS_META[statusFilter].cssVar,
      });
    }
    if (query.trim()) {
      chips.push({
        id: "search",
        key: "Search",
        value: `"${query.trim()}"`,
        tone: null,
      });
    }
    return chips;
  }, [view, statusFilter, query]);

  const collapsedStates = useMemo(() => {
    const set = new Set<TaskState>();
    if (collapsedDone) set.add("done");
    return set;
  }, [collapsedDone]);

  const handleClearChip = useCallback(
    (id: string) => {
      if (id === "view") setView("open");
      else if (id === "status") setStatusFilter(null);
      else if (id === "search") setQuery("");
    },
    [setQuery, setStatusFilter, setView],
  );

  const handleClearAll = useCallback(() => {
    updateParams((p) => {
      p.delete("view");
      p.delete("status");
      p.delete("q");
    });
  }, [updateParams]);

  const handleResetFromNoMatch = useCallback(() => {
    updateParams((p) => {
      p.delete("status");
      p.delete("q");
    });
  }, [updateParams]);

  // Keyboard map per DESIGN.md § 10 — `/`, `Escape`, and `1`-`5` view swap.
  // Row-focus shortcuts (`↑↓ ↵`) are handled natively by the `<Link>` rows
  // already in the tab order, so we don't reimplement focus management.
  useEffect(() => {
    const isEditableTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "/" && !isEditableTarget(e.target)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (e.key === "Escape" && isEditableTarget(e.target)) {
        if (searchInputRef.current && e.target === searchInputRef.current) {
          if (query.length > 0) {
            e.preventDefault();
            setQuery("");
          } else if (statusFilter) {
            e.preventDefault();
            setStatusFilter(null);
            searchInputRef.current.blur();
          } else {
            searchInputRef.current.blur();
          }
        }
        return;
      }

      if (isEditableTarget(e.target)) return;
      const hotkeyView = VIEW_HOTKEYS[e.key];
      if (hotkeyView) {
        e.preventDefault();
        setView(hotkeyView);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [query, setQuery, setStatusFilter, setView, statusFilter]);

  const errorCode: MyTasksListFailureCode | null = error
    ? toFailureCode(error)
    : initialError;

  const meName = session.data?.user.name ?? session.data?.user.email ?? "You";

  if (isFullyEmpty) {
    return (
      <>
        <MyTasksHeader
          totalCount={0}
          viewCounts={countByState([])}
          statusFilter={null}
          onToggleStatus={() => {}}
          dimTotal
        />
        <MyTasksEmpty />
      </>
    );
  }

  return (
    <>
      {errorCode && <ErrorBanner code={errorCode} />}
      <MyTasksHeader
        totalCount={rows.length}
        viewCounts={viewCounts}
        statusFilter={statusFilter}
        onToggleStatus={toggleStatus}
      />
      {pickupTask && view !== "done" && <PickupBanner task={pickupTask} />}
      <SavedViewsTabs
        value={view}
        counts={viewCountsByKey}
        onChange={setView}
      />
      <div className="mt-3.5">
        <MyTasksToolbar
          ref={searchInputRef}
          filterCount={activeChips.length}
          query={query}
          onQueryChange={setQuery}
        />
        <ActiveFilters
          chips={activeChips}
          onClear={handleClearChip}
          onClearAll={handleClearAll}
        />
      </div>
      {groups.length === 0 ? (
        <NoMatch onReset={handleResetFromNoMatch} />
      ) : (
        <MyTasksList
          groups={groups}
          collapsedStates={collapsedStates}
          onToggleCollapsed={(state) => {
            if (state === "done") setCollapsedDone((c) => !c);
          }}
          meName={meName}
        />
      )}
      <MyTasksFooter
        shown={filteredRows.length}
        total={rows.length}
        view={view}
      />
    </>
  );
}

const EMPTY_ROWS: MyTask[] = [];

/** Pin the URL `?view=` param to a known SavedView; fall back to `open`. */
function parseView(raw: string | null): SavedView {
  if (raw && SAVED_VIEWS.includes(raw as SavedView)) return raw as SavedView;
  return "open";
}

/** Pin the URL `?status=` param to a known TaskState; fall back to `null`. */
function parseStatus(raw: string | null): TaskState | null {
  if (raw && VALID_STATUS_FILTERS.has(raw as TaskState)) return raw as TaskState;
  return null;
}

/** Coerce the queryFn error message back into the discriminated failure code. */
function toFailureCode(err: unknown): MyTasksListFailureCode {
  if (err instanceof Error) {
    const code = err.message;
    if (code === "unauthorized" || code === "rate_limited" || code === "unknown") {
      return code;
    }
  }
  return "unknown";
}
