'use client';

import { motion, AnimatePresence } from 'motion/react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createTask, deleteTask } from '@/lib/graph/mutations';
import { useUndo, UndoButton } from '@/hooks/useUndo';
import { IconSearch, IconTrash, IconX } from '@/components/shared/icons';
import type { TaskEdge } from '@/lib/db/schema';
import type { TaskGraphSlim, TaskFull } from '@/lib/data/views';
import type { TaskStatus } from '@/lib/types';
import { taskKeys } from '@/lib/query/keys';
import { fetchTaskBody } from '@/lib/query/queries';
import { listTeamMembersAction } from '@/lib/actions/team-members';
import type { MemberView } from '@/lib/actions/team-members-map';
import { teamKeys } from '@/lib/query/keys';
import {
  PRIORITY_DISPLAY_ORDER,
  PRIORITY_RANK,
  PRIORITY_RANK_UNSET,
  UNPRIORITIZED_KEY,
} from '@/lib/ui/priority';
import { TaskRow } from './TaskRow';
import { TaskGroup, type TaskGroupKey } from './TaskGroup';
import type { GroupKey, SortKey } from './FilterBar';
import { FilterPanel } from './FilterPanel';
import { formatRelative } from './relativeTime';

/** URL search-param keys persisting filter state. */
const FILTER_PARAM_KEYS = { tags: 'tags', categories: 'cat', statuses: 'status', priorities: 'pri', search: 'q' } as const;

/** Display order for status groups — most actionable at the top. */
const GROUP_ORDER: readonly TaskGroupKey[] = [
  'in_progress',
  'ready',
  'planned',
  'plannable',
  'draft',
  'done',
  'cancelled',
];

type TaskWithRef = TaskGraphSlim;

/** Discriminated union describing a group section's identity and label source. */
type GroupSection =
  | { kind: 'status'; key: TaskGroupKey }
  | { kind: 'category'; key: string; label: string }
  | { kind: 'flat' };

interface StructureViewProps {
  /** All project tasks, augmented with composed `taskRef`. */
  tasks: TaskWithRef[];
  /** All project edges. */
  edges: TaskEdge[];
  /** Project UUID. */
  projectId: string;
  /** Organization UUID — feeds the team-member fetch used for row avatars. */
  organizationId: string;
  /** Currently selected task ID. */
  selectedNodeId: string | null;
  /** Click a task to open its detail. */
  onSelectNode: (taskId: string) => void;
  /** Refresh the underlying graph after a mutation. */
  onGraphChange?: () => void;
  /** Whether the filter sheet is visible — owned by NavigatorPanel. */
  filterOpen: boolean;
  /** Active sort key. */
  sort: SortKey;
  /** Active grouping. */
  group: GroupKey;
  /** Available categories for chip filters. */
  categories: string[];
}

/**
 * Decide which group a task belongs to. Reads the server-derived
 * `task.state` so the bucketing matches what `mymir_analyze` and the bundle
 * preview see — no client-side recomputation, no drift.
 *
 * `ready` and `plannable` collapse onto their own lanes; `blocked` for a
 * planned task with unsatisfied deps falls back to the `planned` bucket so
 * the operator still sees it grouped with its peers (the agent-state
 * distinction surfaces in the `mymir_analyze` view, not the structure list).
 *
 * @param task - Task to bucket.
 * @returns Group key.
 */
function groupKeyFor(task: TaskWithRef): TaskGroupKey {
  if (task.state === 'ready') return 'ready';
  if (task.state === 'plannable') return 'plannable';
  return task.status;
}

/**
 * Parse a comma-separated filter param into a Set, dropping empty entries.
 *
 * @param value - Raw param value.
 * @returns Set of trimmed non-empty values.
 */
function parseSet(value: string | null): Set<string> {
  if (!value) return new Set();
  return new Set(value.split(',').map((v) => v.trim()).filter(Boolean));
}

/**
 * Stringify the four filter inputs as a URL query string preserving any
 * other params already present.
 *
 * @param current - Current URLSearchParams snapshot.
 * @param next - Filter values to apply.
 * @returns Query string starting with `?`, or empty when nothing remains.
 */
function serializeFilters(
  current: URLSearchParams,
  next: { tags: Set<string>; categories: Set<string>; statuses: Set<string>; priorities: Set<string>; search: string },
): string {
  const out = new URLSearchParams(current);
  const apply = (key: string, set: Set<string>) => {
    if (set.size === 0) out.delete(key);
    else out.set(key, [...set].join(','));
  };
  apply(FILTER_PARAM_KEYS.tags, next.tags);
  apply(FILTER_PARAM_KEYS.categories, next.categories);
  apply(FILTER_PARAM_KEYS.statuses, next.statuses);
  apply(FILTER_PARAM_KEYS.priorities, next.priorities);
  if (next.search.trim()) out.set(FILTER_PARAM_KEYS.search, next.search.trim());
  else out.delete(FILTER_PARAM_KEYS.search);
  const qs = out.toString();
  return qs ? `?${qs}` : '';
}

interface DepsMap {
  /** Task ID → number of upstream `depends_on` edges. */
  upstream: Map<string, number>;
  /** Task ID → number of downstream `depends_on` edges. */
  downstream: Map<string, number>;
}

/**
 * Pre-compute per-task dependency counts in one pass over edges.
 *
 * @param edges - Project edges.
 * @returns Maps keyed by task ID.
 */
function buildDepsMap(edges: TaskEdge[]): DepsMap {
  const upstream = new Map<string, number>();
  const downstream = new Map<string, number>();
  for (const edge of edges) {
    if (edge.edgeType !== 'depends_on') continue;
    upstream.set(edge.sourceTaskId, (upstream.get(edge.sourceTaskId) ?? 0) + 1);
    downstream.set(edge.targetTaskId, (downstream.get(edge.targetTaskId) ?? 0) + 1);
  }
  return { upstream, downstream };
}

interface DeletedTask {
  /** Task title for the undo toast. */
  title: string;
  /** Snapshot used to recreate the task on undo. */
  taskData: TaskFull;
}

/**
 * Sort tasks within a group based on the active sort key. Stable for the
 * common sort keys so adjacent rows don't re-shuffle on minor updates.
 *
 * @param items - Tasks to sort.
 * @param key - Sort key.
 * @returns Sorted shallow copy.
 */
function sortTasks(items: TaskWithRef[], key: SortKey): TaskWithRef[] {
  const copy = [...items];
  if (key === 'updated') {
    copy.sort((a, b) => {
      const at = a.updatedAt ? Date.parse(String(a.updatedAt)) : 0;
      const bt = b.updatedAt ? Date.parse(String(b.updatedAt)) : 0;
      return bt - at;
    });
  } else if (key === 'identifier') {
    copy.sort((a, b) => a.taskRef.localeCompare(b.taskRef, undefined, { numeric: true }));
  } else if (key === 'priority') {
    // Unset priorities sort below the lowest assigned value so the user
    // sees a meaningful gradient first; ties fall back to `order` to keep
    // adjacent rows stable.
    copy.sort((a, b) => {
      const ap = a.priority ? PRIORITY_RANK[a.priority] : PRIORITY_RANK_UNSET;
      const bp = b.priority ? PRIORITY_RANK[b.priority] : PRIORITY_RANK_UNSET;
      if (ap !== bp) return ap - bp;
      return a.order - b.order;
    });
  } else {
    copy.sort((a, b) => a.order - b.order);
  }
  return copy;
}

/**
 * Linear-density structure view — flat task list grouped by status with a
 * filter sheet, sort cycler, and inline new-task input. Owns its own URL
 * sync for filter state so deep-links and refresh reproduce the same view.
 *
 * @param props - Structure view configuration.
 * @returns Filter bar + task list inside a flex column.
 */
export function StructureView({
  tasks,
  edges,
  projectId,
  organizationId,
  selectedNodeId,
  onSelectNode,
  onGraphChange,
  filterOpen,
  sort,
  group,
  categories,
}: StructureViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [activeStatuses, setActiveStatuses] = useState<Set<string>>(() => parseSet(searchParams.get(FILTER_PARAM_KEYS.statuses)));
  const [activeCategories, setActiveCategories] = useState<Set<string>>(() => parseSet(searchParams.get(FILTER_PARAM_KEYS.categories)));
  const [activeTags, setActiveTags] = useState<Set<string>>(() =>
    parseSet(searchParams.get(FILTER_PARAM_KEYS.tags)),
  );
  const [activePriorities, setActivePriorities] = useState<Set<string>>(() => {
    // Sanitize the URL value to the four schema priorities + the unset
    // sentinel so a stale bookmark with an unknown token cannot empty the
    // list.
    const parsed = parseSet(searchParams.get(FILTER_PARAM_KEYS.priorities));
    const allowed = new Set<string>([UNPRIORITIZED_KEY, ...PRIORITY_DISPLAY_ORDER]);
    for (const p of [...parsed]) if (!allowed.has(p)) parsed.delete(p);
    return parsed;
  });
  const [search, setSearch] = useState<string>(() => searchParams.get(FILTER_PARAM_KEYS.search) ?? '');
  const [addingToGroup, setAddingToGroup] = useState<TaskGroupKey | null>(null);
  const [addTitle, setAddTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const pendingDeleteBodyRef = useRef<Map<string, Promise<TaskFull | null>>>(new Map());
  const filtersRef = useRef({ tags: activeTags, categories: activeCategories, statuses: activeStatuses, priorities: activePriorities, search });

  filtersRef.current = { tags: activeTags, categories: activeCategories, statuses: activeStatuses, priorities: activePriorities, search };

  useEffect(() => {
    const qs = serializeFilters(searchParams, filtersRef.current);
    const currentQs = searchParams.toString() ? `?${searchParams.toString()}` : '';
    // Skip the no-op `router.replace` on mount when filter state already
    // mirrors the URL (initial state is parsed FROM the URL via
    // `searchParams.get(...)` above). Each `router.replace` triggers an
    // RSC refetch of the project layout — strict-mode dev would fire it
    // twice. Comparing against the current querystring elides both.
    if (qs === currentQs) return;
    router.replace(`${pathname}${qs}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTags, activeCategories, activeStatuses, activePriorities, search]);

  // Shared team-member cache: PropRail's AssigneePicker uses the same key,
  // so the first surface that fires the query warms the cache for the
  // other. Fires eagerly here because rows render names without a popover
  // open; 5-minute staleTime keeps it cheap across navigation.
  const { data: teamMembers } = useQuery({
    queryKey: teamKeys.members(organizationId),
    queryFn: async () => {
      const result = await listTeamMembersAction({ organizationId });
      if (!result.ok) throw new Error(`list-team-members:${result.code}`);
      return result.data;
    },
    staleTime: 5 * 60_000,
  });
  const memberLookup = useMemo<ReadonlyMap<string, MemberView>>(
    () => {
      const map = new Map<string, MemberView>();
      for (const m of teamMembers ?? []) map.set(m.userId, m);
      return map;
    },
    [teamMembers],
  );

  const depsMap = useMemo(() => buildDepsMap(edges), [edges]);

  const tasksByGroup = useMemo(() => {
    const groups = new Map<TaskGroupKey, TaskWithRef[]>();
    for (const task of tasks) {
      const key = groupKeyFor(task);
      const list = groups.get(key) ?? [];
      list.push(task);
      groups.set(key, list);
    }
    return groups;
  }, [tasks]);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const list = (task.tags as string[] | null) ?? [];
      for (const tag of list) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])) as ReadonlyArray<readonly [string, number]>;
  }, [tasks]);

  const statusCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [key, list] of tasksByGroup.entries()) {
      out[key] = list.length;
    }
    return out;
  }, [tasksByGroup]);

  const categoryCounts = useMemo(() => {
    const out: Record<string, number> = { __uncategorized__: 0 };
    for (const t of tasks) {
      const cat = t.category;
      if (!cat) out.__uncategorized__ += 1;
      else out[cat] = (out[cat] ?? 0) + 1;
    }
    return out;
  }, [tasks]);

  const priorityCounts = useMemo(() => {
    const out: Record<string, number> = { [UNPRIORITIZED_KEY]: 0 };
    for (const p of PRIORITY_DISPLAY_ORDER) out[p] = 0;
    for (const t of tasks) {
      if (t.priority) out[t.priority] += 1;
      else out[UNPRIORITIZED_KEY] += 1;
    }
    return out;
  }, [tasks]);

  const visibleTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      const groupKey = groupKeyFor(t);

      if (activeStatuses.size > 0 && !activeStatuses.has(groupKey)) return false;

      if (activeCategories.size > 0) {
        if (!t.category && !activeCategories.has('Uncategorized')) return false;
        if (t.category && !activeCategories.has(t.category)) return false;
      }

      if (activeTags.size > 0) {
        const list = (t.tags as string[] | null) ?? [];
        if (!list.some((tag) => activeTags.has(tag))) return false;
      }

      if (activePriorities.size > 0) {
        const key = t.priority ?? UNPRIORITIZED_KEY;
        if (!activePriorities.has(key)) return false;
      }

      if (q) {
        const haystack = `${t.title} ${t.taskRef}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }

      return true;
    });
  }, [tasks, activeStatuses, activeCategories, activeTags, activePriorities, search]);

  const groupedVisible = useMemo<ReadonlyArray<readonly [GroupSection, TaskWithRef[]]>>(() => {
    if (group === 'none') {
      return [[ { kind: 'flat' }, sortTasks(visibleTasks, sort) ]];
    }
    if (group === 'category') {
      const map = new Map<string, TaskWithRef[]>();
      for (const task of visibleTasks) {
        const key = task.category ?? '__uncategorized__';
        const list = map.get(key) ?? [];
        list.push(task);
        map.set(key, list);
      }
      const labels = [...map.keys()].sort((a, b) => {
        if (a === '__uncategorized__') return 1;
        if (b === '__uncategorized__') return -1;
        return a.localeCompare(b);
      });
      return labels.map((key) => [
        { kind: 'category' as const, key, label: key === '__uncategorized__' ? 'Uncategorized' : key },
        sortTasks(map.get(key) ?? [], sort),
      ] as const);
    }
    const map = new Map<TaskGroupKey, TaskWithRef[]>();
    for (const task of visibleTasks) {
      const key = groupKeyFor(task);
      const list = map.get(key) ?? [];
      list.push(task);
      map.set(key, list);
    }
    return GROUP_ORDER
      .filter((key) => (map.get(key)?.length ?? 0) > 0)
      .map((key) => [
        { kind: 'status' as const, key },
        sortTasks(map.get(key) ?? [], sort),
      ] as const);
  }, [visibleTasks, sort, group]);

  const toggleStatus = useCallback((id: string) => {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((id: string) => {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleTag = useCallback((id: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const togglePriority = useCallback((id: string) => {
    setActivePriorities((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setActiveStatuses(new Set());
    setActiveCategories(new Set());
    setActiveTags(new Set());
    setActivePriorities(new Set());
    setSearch('');
  }, []);

  const handleStartNewTask = useCallback((groupKey: TaskGroupKey) => {
    setAddingToGroup(groupKey);
    setAddTitle('');
  }, []);

  const handleAddTask = useCallback(async (groupKey: TaskGroupKey) => {
    const trimmed = addTitle.trim();
    if (!trimmed) {
      setAddingToGroup(null);
      return;
    }
    const status: TaskStatus = groupKey === 'ready'
      ? 'planned'
      : groupKey === 'plannable' || groupKey === 'cancelled'
        ? 'draft'
        : (groupKey as TaskStatus);
    await createTask({
      projectId,
      title: trimmed,
      description: '',
      status,
      order: tasks.length,
    });
    setAddingToGroup(null);
    setAddTitle('');
    onGraphChange?.();
  }, [addTitle, projectId, tasks.length, onGraphChange]);

  const handleRestore = useCallback(async (item: DeletedTask) => {
    const t = item.taskData;
    await createTask({
      projectId: t.projectId,
      title: t.title,
      description: t.description,
      status: t.status,
      order: tasks.length,
      acceptanceCriteria: t.acceptanceCriteria,
      decisions: t.decisions,
      implementationPlan: t.implementationPlan,
      executionRecord: t.executionRecord,
      tags: t.tags,
      category: t.category,
      files: t.files,
    });
    onGraphChange?.();
  }, [tasks.length, onGraphChange]);

  const { canUndo, push: pushUndo, undo } = useUndo<DeletedTask>({
    onUndo: handleRestore,
    keyboard: { panelSelector: '[data-panel="navigator"]' },
  });

  const queryClient = useQueryClient();

  // Prefetch the heavy task body when the inline confirm dialog opens. The
  // user's confirmation pause hides the round-trip so `handleDelete` can
  // resolve the cached promise instead of blocking on a fresh fetch.
  useEffect(() => {
    if (!confirmDelete) return;
    const id = confirmDelete;
    if (pendingDeleteBodyRef.current.has(id)) return;
    pendingDeleteBodyRef.current.set(
      id,
      queryClient
        .fetchQuery({
          queryKey: taskKeys.detail(projectId, id),
          queryFn: fetchTaskBody(queryClient, projectId, id),
        })
        .then((data) => (data as TaskFull | undefined) ?? null)
        .catch(() => null),
    );
  }, [confirmDelete, queryClient, projectId]);

  const handleDelete = useCallback(async (taskId: string) => {
    const slim = tasks.find((t) => t.id === taskId);
    const bodyPromise =
      pendingDeleteBodyRef.current.get(taskId) ??
      queryClient
        .fetchQuery({
          queryKey: taskKeys.detail(projectId, taskId),
          queryFn: fetchTaskBody(queryClient, projectId, taskId),
        })
        .then((data) => (data as TaskFull | undefined) ?? null)
        .catch(() => null);
    // Await the GET before firing the DELETE so the server reads the
    // pre-deletion state — a parallel `Promise.all` could let the DELETE
    // win the race and the GET return 404.
    const full = await bodyPromise;
    pendingDeleteBodyRef.current.delete(taskId);
    if (slim && full) pushUndo({ title: slim.title, taskData: full });
    await deleteTask(taskId);
    setConfirmDelete(null);
    onGraphChange?.();
  }, [tasks, pushUndo, onGraphChange, queryClient, projectId]);

  const totalActiveFilters = activeStatuses.size + activeCategories.size + activeTags.size + activePriorities.size + (search.trim() ? 1 : 0);

  return (
    <div className="flex h-full flex-col">
      <SearchRow value={search} onChange={setSearch} />

      <FilterPanel
        open={filterOpen}
        activeStatuses={activeStatuses}
        onStatusToggle={toggleStatus}
        categories={categories}
        activeCategories={activeCategories}
        onCategoryToggle={toggleCategory}
        tags={allTags}
        activeTags={activeTags}
        onTagToggle={toggleTag}
        priorities={PRIORITY_DISPLAY_ORDER}
        activePriorities={activePriorities}
        onPriorityToggle={togglePriority}
        statusCounts={statusCounts}
        categoryCounts={categoryCounts}
        priorityCounts={priorityCounts}
        totalActive={totalActiveFilters}
        onClearAll={clearFilters}
      />

      <AnimatePresence>
        {canUndo && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-2 border-b border-border bg-surface-raised/40 px-4 py-1.5"
          >
            <span className="text-[11px] text-text-secondary">Task deleted</span>
            <UndoButton canUndo={canUndo} onUndo={undo} className="ml-auto" />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 overflow-y-auto">
        {tasks.length === 0 ? (
          <EmptyTasks />
        ) : groupedVisible.length === 0 ? (
          <EmptyFilter onClear={clearFilters} />
        ) : (
          groupedVisible.map(([section, groupTasks]) => (
            <GroupSectionRenderer
              key={sectionKey(section)}
              section={section}
              count={groupTasks.length}
              onAdd={section.kind === 'status' ? () => handleStartNewTask(section.key) : undefined}
            >
              {section.kind === 'status' && addingToGroup === section.key && (
                <NewTaskRow
                  value={addTitle}
                  onChange={setAddTitle}
                  onCommit={() => handleAddTask(section.key)}
                  onCancel={() => { setAddingToGroup(null); setAddTitle(''); }}
                />
              )}
              {groupTasks.map((task) => {
                return (
                  <TaskRow
                    key={task.id}
                    id={task.id}
                    taskRef={task.taskRef}
                    title={task.title}
                    status={task.status}
                    category={task.category}
                    priority={task.priority}
                    assigneeUserIds={task.assigneeUserIds}
                    memberLookup={memberLookup}
                    upstreamCount={depsMap.upstream.get(task.id) ?? 0}
                    downstreamCount={depsMap.downstream.get(task.id) ?? 0}
                    lastActive={formatRelative(task.updatedAt)}
                    selected={selectedNodeId === task.id}
                    isReady={task.state === 'ready'}
                    isPlannable={task.state === 'plannable'}
                    onClick={() => onSelectNode(task.id)}
                    trailingPersistent={confirmDelete === task.id}
                    trailing={
                      confirmDelete === task.id ? (
                        <DeleteConfirm
                          onConfirm={() => handleDelete(task.id)}
                          onCancel={() => setConfirmDelete(null)}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setConfirmDelete(task.id); }}
                          className="cursor-pointer rounded p-1 text-text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-danger"
                          aria-label={`Delete ${task.taskRef}`}
                          title={`Delete ${task.taskRef}`}
                        >
                          <IconTrash size={11} />
                        </button>
                      )
                    }
                  />
                );
              })}
            </GroupSectionRenderer>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Stable key for a section — drives React reconciliation while groups
 * change between status and category modes.
 *
 * @param section - Section discriminator.
 * @returns String key.
 */
function sectionKey(section: GroupSection): string {
  if (section.kind === 'flat') return '__flat__';
  if (section.kind === 'status') return `status:${section.key}`;
  return `category:${section.key}`;
}

interface GroupSectionRendererProps {
  /** Discriminator that drives label + glyph choice. */
  section: GroupSection;
  /** Number of tasks in this section. */
  count: number;
  /** Optional add handler — only present for status groups. */
  onAdd?: () => void;
  /** Section body. */
  children: React.ReactNode;
}

/**
 * Render a status, category, or flat section. Status delegates to
 * `TaskGroup` so the original status-glyph/uppercase aesthetic is shared.
 *
 * @param props - Section props.
 * @returns Section element with its children.
 */
function GroupSectionRenderer({ section, count, onAdd, children }: GroupSectionRendererProps) {
  if (section.kind === 'status') {
    return <TaskGroup status={section.key} count={count} onAdd={onAdd}>{children}</TaskGroup>;
  }
  if (section.kind === 'flat') {
    return <>{children}</>;
  }
  return (
    <>
      <div className="sticky top-0 z-10 flex h-[30px] items-center gap-2 border-y border-border bg-base-2 px-4">
        <span aria-hidden="true" className="h-2 w-2 rounded-sm border border-border-strong bg-surface-raised" />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.10em] text-text-secondary">
          {section.label}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-text-faint">{count}</span>
      </div>
      {children}
    </>
  );
}

interface NewTaskRowProps {
  /** Live input value. */
  value: string;
  /** Update the input. */
  onChange: (next: string) => void;
  /** Commit the new task on Enter / blur. */
  onCommit: () => void;
  /** Cancel without saving. */
  onCancel: () => void;
}

/**
 * Inline new-task input rendered above the rows in the active group.
 *
 * @param props - Input configuration.
 * @returns Compact input row with a confirm hint.
 */
function NewTaskRow({ value, onChange, onCommit, onCancel }: NewTaskRowProps) {
  const cancelRef = useRef(false);
  return (
    <div className="flex h-[34px] items-center gap-2 border-b border-border bg-surface-raised/30 px-4">
      <span aria-hidden="true" className="h-2 w-2 rounded-full border border-dashed border-border-strong" />
      <input
        type="text"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (cancelRef.current) {
            cancelRef.current = false;
            onCancel();
          } else {
            onCommit();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === 'Escape') { cancelRef.current = true; e.currentTarget.blur(); }
        }}
        placeholder="Task title…"
        className="flex-1 bg-transparent text-[13px] text-text-primary placeholder:text-text-muted/60 outline-none"
      />
      <span className="font-mono text-[10px] text-text-faint">↵ to add · Esc to cancel</span>
    </div>
  );
}

interface DeleteConfirmProps {
  /** Permanently delete the task. */
  onConfirm: () => void;
  /** Dismiss the confirmation. */
  onCancel: () => void;
}

/**
 * Two-step delete confirm rendered inline in the trailing slot of a row.
 *
 * @param props - Delete handlers.
 * @returns Pair of mono buttons.
 */
function DeleteConfirm({ onConfirm, onCancel }: DeleteConfirmProps) {
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onConfirm(); }}
        className="cursor-pointer rounded px-1.5 py-px font-mono text-[10px] font-semibold text-danger hover:bg-danger/15"
      >
        Delete
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onCancel(); }}
        className="cursor-pointer rounded p-1 text-text-muted hover:text-text-secondary"
        aria-label="Cancel delete"
      >
        <IconX size={10} />
      </button>
    </span>
  );
}

/**
 * Project-empty hint shown when no tasks have been created yet.
 *
 * @returns Centred hint card.
 */
function EmptyTasks() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="text-sm text-text-secondary">No tasks yet</p>
      <p className="text-xs text-text-muted">Use the chat or your CLI agent to draft tasks.</p>
    </div>
  );
}

interface SearchRowProps {
  /** Live search query. */
  value: string;
  /** Update the search query. */
  onChange: (next: string) => void;
}

/**
 * Always-visible search row above the task list. Mirrors the prototype's
 * compact mono input — the filter panel chip groups stack underneath when
 * the user expands them.
 *
 * @param props - Search row props.
 * @returns Compact search input row.
 */
function SearchRow({ value, onChange }: SearchRowProps) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-base-2/40 px-3 py-1.5">
      <span aria-hidden="true" className={value ? 'text-accent-light' : 'text-text-faint'}>
        <IconSearch size={11} />
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search tasks by title or ID…"
        className="flex-1 bg-transparent font-mono text-[11.5px] text-text-primary placeholder:text-text-muted/50 outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="cursor-pointer rounded p-0.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
          aria-label="Clear search"
        >
          <IconX size={10} />
        </button>
      )}
    </div>
  );
}

interface EmptyFilterProps {
  /** Clear all filters from the parent. */
  onClear: () => void;
}

/**
 * Hint shown when filters narrow the list to zero — exposes a clear-all
 * button so the user can recover without consulting the sheet.
 *
 * @param props - Clear handler.
 * @returns Centred hint card with a recovery action.
 */
function EmptyFilter({ onClear }: EmptyFilterProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm text-text-secondary">No tasks match the active filters</p>
      <button
        type="button"
        onClick={onClear}
        className="cursor-pointer font-mono text-[11px] text-accent-light hover:underline"
      >
        Clear filters
      </button>
    </div>
  );
}

export default StructureView;
