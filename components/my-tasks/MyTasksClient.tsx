"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/providers/SessionProvider";
import { STATUS_META } from "@/components/shared/StatusGlyph";
import type { TaskState } from "@/lib/data/task";
import type { MyTask } from "@/lib/data/views";
import { listMyTasks, type MyTasksListFailureCode } from "@/lib/graph/queries";
import { myTasksKeys } from "@/lib/query/keys";
import { UNPRIORITIZED_KEY } from "@/lib/ui/priority";
import { ActiveFilters, type ActiveFilterChip } from "./ActiveFilters";
import { ErrorBanner } from "./ErrorBanner";
import { MyTasksEmpty } from "./MyTasksEmpty";
import { MyTasksFilterPanel } from "./MyTasksFilterPanel";
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
  applyGrouping,
  buildSearchHaystacks,
  countByState,
  matchesPriority,
  matchesSearch,
  parsePrioritySet,
  parseStatusSet,
  pickPickupTask,
  serializePrioritySet,
  serializeStatusSet,
  sortRows,
  viewPredicate,
  type GroupKey,
  type SavedView,
  type SortKey,
} from "./predicates";

const VIEW_HOTKEYS: Record<string, SavedView> = {
  "1": "open",
  "2": "today",
  "3": "stale",
  "4": "done",
  "5": "all",
};

const VALID_SORTS: ReadonlySet<SortKey> = new Set<SortKey>([
  "updated",
  "priority",
  "status",
  "id",
]);

const VALID_GROUPS: ReadonlySet<GroupKey> = new Set<GroupKey>([
  "status",
  "project",
  "none",
]);

// `backlog` uses `--color-text-secondary` (not muted) so the chip clears
// the WCAG AA 4.5:1 contrast bar on its own 12% tint — `--color-text-muted`
// computed to 2.8:1 in light mode.
const PRIORITY_CHIP_TONE: Record<string, string> = {
  urgent: "var(--color-danger)",
  core: "var(--color-progress)",
  normal: "var(--color-text-secondary)",
  backlog: "var(--color-text-secondary)",
};

interface MyTasksClientProps {
  initialError?: MyTasksListFailureCode | null;
}

export function MyTasksClient({ initialError = null }: MyTasksClientProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? "/my-tasks";
  const session = useAuth();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const view = parseView(searchParams.get("view"));
  const statusFilter = useMemo(
    () => parseStatusSet(searchParams.get("status")),
    [searchParams],
  );
  const priorityFilter = useMemo(
    () => parsePrioritySet(searchParams.get("priority")),
    [searchParams],
  );
  const sort = parseSort(searchParams.get("sort"));
  const group = parseGroup(searchParams.get("group"));

  // Local state, not URL, so the input renders without a router round-trip.
  // A debounced effect below mirrors to `?q=` for deep-links and back/forward.
  const [query, setQuery] = useState<string>(() => searchParams.get("q") ?? "");

  const [collapsedDone, setCollapsedDone] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);

  const { data, error, isSuccess } = useQuery<MyTask[]>({
    queryKey: myTasksKeys.list(),
    queryFn: async () => {
      const payload = await listMyTasks();
      if (!payload.ok) throw new Error(payload.code);
      return payload.rows;
    },
    // SSR primes the cache via setQueryData in app/my-tasks/page.tsx; trust
    // that snapshot on mount so we don't burn a second rate-limit slot just
    // to re-fetch what we already have. SSE invalidations still refetch.
    staleTime: 30_000,
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
        p.delete("priority");
      });
    },
    [updateParams],
  );

  const writeStatusSet = useCallback(
    (next: ReadonlySet<TaskState>) => {
      updateParams((p) => {
        if (next.size === 0) p.delete("status");
        else p.set("status", serializeStatusSet(next));
      });
    },
    [updateParams],
  );

  const toggleStatus = useCallback(
    (state: TaskState) => {
      const next = new Set(statusFilter);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      writeStatusSet(next);
    },
    [statusFilter, writeStatusSet],
  );

  const writePrioritySet = useCallback(
    (next: ReadonlySet<string>) => {
      updateParams((p) => {
        if (next.size === 0) p.delete("priority");
        else p.set("priority", serializePrioritySet(next));
      });
    },
    [updateParams],
  );

  const togglePriority = useCallback(
    (value: string) => {
      const next = new Set(priorityFilter);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      writePrioritySet(next);
    },
    [priorityFilter, writePrioritySet],
  );

  useEffect(() => {
    const trimmed = query.trim();
    const current = searchParams.get("q") ?? "";
    if (trimmed === current.trim()) return;
    const handle = setTimeout(() => {
      updateParams((p) => {
        if (trimmed.length === 0) p.delete("q");
        else p.set("q", trimmed);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [query, searchParams, updateParams]);

  const setSort = useCallback(
    (next: SortKey) => {
      updateParams((p) => {
        if (next === "updated") p.delete("sort");
        else p.set("sort", next);
      });
    },
    [updateParams],
  );

  const setGroup = useCallback(
    (next: GroupKey) => {
      updateParams((p) => {
        if (next === "status") p.delete("group");
        else p.set("group", next);
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

  // Counts over view-only rows so the panel still shows totals after the
  // operator has narrowed status / search / priority.
  const priorityCounts = useMemo(() => {
    const counts: Record<string, number> = {
      urgent: 0,
      core: 0,
      normal: 0,
      backlog: 0,
      [UNPRIORITIZED_KEY]: 0,
    };
    for (const row of viewRows) {
      const key = row.priority ?? UNPRIORITIZED_KEY;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [viewRows]);

  // Memoised off `rows` (not `query`) so every keystroke reuses the same
  // lowercased blob per row instead of re-allocating the field array and
  // re-lowercasing inside the matcher.
  const haystacks = useMemo(() => buildSearchHaystacks(rows), [rows]);

  const filteredRows = useMemo(() => {
    let list: MyTask[] = viewRows;
    if (statusFilter.size > 0)
      list = list.filter((r) => statusFilter.has(r.state));
    if (priorityFilter.size > 0)
      list = list.filter((r) => matchesPriority(r, priorityFilter));
    if (query.trim()) {
      list = list.filter((r) =>
        matchesSearch(r, query, haystacks.get(r.id) ?? ""),
      );
    }
    return list;
  }, [viewRows, statusFilter, priorityFilter, query, haystacks]);

  const sortedRows = useMemo(
    () => sortRows(filteredRows, sort),
    [filteredRows, sort],
  );

  const displayGroups = useMemo(
    () => applyGrouping(sortedRows, group),
    [sortedRows, group],
  );

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
        id: `view:${view}`,
        key: "View",
        value: SAVED_VIEW_LABEL[view],
        tone: "var(--color-accent)",
      });
    }
    for (const state of statusFilter) {
      chips.push({
        id: `status:${state}`,
        key: "Status",
        value: STATUS_META[state].label,
        tone: STATUS_META[state].cssVar,
      });
    }
    for (const priority of priorityFilter) {
      chips.push({
        id: `priority:${priority}`,
        key: "Priority",
        value: priority === UNPRIORITIZED_KEY ? "Unprioritized" : priority,
        tone: PRIORITY_CHIP_TONE[priority] ?? "var(--color-text-secondary)",
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
  }, [view, statusFilter, priorityFilter, query]);

  // View chips are presentation-only, not counted.
  const filterCount =
    statusFilter.size + priorityFilter.size + (query.trim() ? 1 : 0);

  const collapsedKeys = useMemo(() => {
    const set = new Set<string>();
    if (collapsedDone) set.add("done");
    return set;
  }, [collapsedDone]);

  const handleClearChip = useCallback(
    (id: string) => {
      if (id.startsWith("view:")) {
        setView("open");
        return;
      }
      if (id.startsWith("status:")) {
        const state = id.slice("status:".length) as TaskState;
        const next = new Set(statusFilter);
        next.delete(state);
        writeStatusSet(next);
        return;
      }
      if (id.startsWith("priority:")) {
        const value = id.slice("priority:".length);
        const next = new Set(priorityFilter);
        next.delete(value);
        writePrioritySet(next);
        return;
      }
      if (id === "search") setQuery("");
    },
    [
      priorityFilter,
      setQuery,
      setView,
      statusFilter,
      writePrioritySet,
      writeStatusSet,
    ],
  );

  const handleClearAll = useCallback(() => {
    setQuery("");
    updateParams((p) => {
      p.delete("view");
      p.delete("status");
      p.delete("priority");
      p.delete("q");
    });
  }, [updateParams]);

  const handleResetFromNoMatch = useCallback(() => {
    setQuery("");
    updateParams((p) => {
      p.delete("status");
      p.delete("priority");
      p.delete("q");
    });
  }, [updateParams]);

  const handleToggleCollapsed = useCallback((key: string) => {
    if (key === "done") setCollapsedDone((c) => !c);
  }, []);

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
          } else if (statusFilter.size > 0) {
            e.preventDefault();
            writeStatusSet(new Set());
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
        // Don't hijack number keys while a popover or modal owns focus.
        // Dropdowns, command palette, and confirm dialogs all use these
        // ARIA roles, and a digit press inside them should reach their own
        // handlers (or simply do nothing) rather than swap the saved view.
        if (
          document.querySelector(
            '[role="listbox"], [role="menu"], [role="dialog"], [aria-modal="true"]',
          )
        ) {
          return;
        }
        e.preventDefault();
        setView(hotkeyView);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [query, setQuery, setView, statusFilter, writeStatusSet]);

  // Once the client has a successful fetch the SSR error is stale, so clear it.
  const errorCode: MyTasksListFailureCode | null = error
    ? toFailureCode(error)
    : isSuccess
      ? null
      : initialError;

  const meName = session.data?.user.name ?? session.data?.user.email ?? "You";

  // Scroll container for the `MyTasksList` virtualizer. State, not a ref, so
  // attaching the node re-renders and the virtualizer re-measures it after
  // layout settles; a plain ref measured only in the mount commit can read
  // height 0 on client navigation and never recover.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  if (isFullyEmpty) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1080px] px-8 pt-7 pb-20">
          <MyTasksHeader
            totalCount={0}
            viewCounts={countByState([])}
            statusFilter={EMPTY_STATUS_SET}
            onToggleStatus={() => {}}
            dimTotal
          />
          <MyTasksEmpty />
        </div>
      </div>
    );
  }

  return (
    <div ref={setScrollEl} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-8 pt-7 pb-20">
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
            filterOpen={filterOpen}
            onToggleFilter={() => setFilterOpen((v) => !v)}
            filterCount={filterCount}
            group={group}
            onGroupChange={setGroup}
            sort={sort}
            onSortChange={setSort}
            query={query}
            onQueryChange={setQuery}
          />
          <MyTasksFilterPanel
            open={filterOpen}
            activePriorities={priorityFilter}
            priorityCounts={priorityCounts}
            onPriorityToggle={togglePriority}
            totalActive={filterCount}
            onClearAll={handleClearAll}
          />
          <ActiveFilters
            chips={activeChips}
            onClear={handleClearChip}
            onClearAll={handleClearAll}
          />
        </div>
        {displayGroups.length === 0 ? (
          <NoMatch onReset={handleResetFromNoMatch} />
        ) : (
          <MyTasksList
            groups={displayGroups}
            collapsedKeys={collapsedKeys}
            onToggleCollapsed={handleToggleCollapsed}
            meName={meName}
            scrollEl={scrollEl}
          />
        )}
        <MyTasksFooter shown={sortedRows.length} total={rows.length} />
      </div>
    </div>
  );
}

const EMPTY_ROWS: MyTask[] = [];
const EMPTY_STATUS_SET: ReadonlySet<TaskState> = new Set();

function parseView(raw: string | null): SavedView {
  if (raw && SAVED_VIEWS.includes(raw as SavedView)) return raw as SavedView;
  return "open";
}

function parseSort(raw: string | null): SortKey {
  if (raw && VALID_SORTS.has(raw as SortKey)) return raw as SortKey;
  return "updated";
}

function parseGroup(raw: string | null): GroupKey {
  if (raw && VALID_GROUPS.has(raw as GroupKey)) return raw as GroupKey;
  return "status";
}

function toFailureCode(err: unknown): MyTasksListFailureCode {
  if (err instanceof Error) {
    const code = err.message;
    if (
      code === "unauthorized" ||
      code === "rate_limited" ||
      code === "unknown"
    ) {
      return code;
    }
  }
  return "unknown";
}
