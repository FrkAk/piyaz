'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '@/components/shared/Avatar';
import { Markdown } from '@/components/shared/Markdown';
import { MonoId } from '@/components/shared/MonoId';
import { PriorityIcon } from '@/components/shared/PriorityIcon';
import { StatusGlyph, STATUS_META } from '@/components/shared/StatusGlyph';
import { Dropdown } from '@/components/shared/Dropdown';
import { useUndo, UndoButton } from '@/hooks/useUndo';
import { popoverFixedStyle, usePopoverAnchor } from '@/hooks/usePopoverAnchor';
import { updateTask } from '@/lib/graph/mutations';
import { projectColor } from '@/lib/ui/project-color';
import { listTeamMembersAction } from '@/lib/actions/team-members';
import type { MemberView } from '@/lib/actions/team-members-map';
import {
  IconBranch,
  IconChevronDown,
  IconClock,
  IconDoc,
  IconFlag,
  IconPlus,
  IconSearch,
  IconTag,
  IconUser,
  IconX,
} from '@/components/shared/icons';
import type { TaskEdge } from '@/lib/db/schema';
import type { Priority, Estimate, TaskStatus } from '@/lib/types';
import type { AssigneeRef, ProjectGraphSlim, TaskFull } from '@/lib/data/views';

/**
 * Subset of task fields safe to patch onto both the `TaskFull` and
 * `TaskGraphSlim` caches. Restricted to fields that exist on the slim
 * shape so a spread `{ ...t, ...patch }` produces a valid slim entry —
 * fields not in this list (description, decisions, history) live only on
 * TaskFull and would have to be patched there separately.
 */
type TaskPatch = Partial<{
  status: TaskStatus;
  priority: Priority | null;
  estimate: Estimate | null;
  category: string | null;
  tags: string[];
}>;
import { PRIORITY_COLOR, PRIORITY_DISPLAY_ORDER } from '@/lib/ui/priority';
import { projectKeys, taskKeys, teamKeys } from '@/lib/query/keys';

/** Display order for the Status dropdown — matches the lifecycle ribbon. */
const STATUS_OPTIONS: readonly TaskStatus[] = ['draft', 'planned', 'in_progress', 'done', 'cancelled'];
/** Display order for the Estimate dropdown — Fibonacci story points. */
const ESTIMATE_OPTIONS: readonly Estimate[] = [1, 2, 3, 5, 8, 13];
/** Sentinel used by dropdowns to model the "clear" action under `string` schemas. */
const SENTINEL_CLEAR = '__clear__';

interface PropRailProps {
  /** Task UUID. */
  taskId: string;
  /** Project UUID — needed to address the slim graph and task detail caches for optimistic updates. */
  projectId: string;
  /** Task status. */
  status: TaskStatus;
  /** Task priority, or null when unset. */
  priority: Priority | null;
  /** Task Fibonacci-point estimate, or null when unset. */
  estimate: Estimate | null;
  /** Assignees on the task — drives the avatar stack trigger. */
  assignees: AssigneeRef[];
  /** Organization UUID the project belongs to — feeds the team-member fetch. */
  organizationId: string;
  /** Task category, or null. */
  category: string | null;
  /** Available categories for the inline picker. */
  categories: string[];
  /** Tags currently attached to the task. */
  tags: string[];
  /** Project tag vocabulary — every tag used by any task in the project. */
  projectTags: string[];
  /** Edges connected to this task. */
  edges: TaskEdge[];
  /** Map of every task in the project. */
  taskMap: Map<string, { title: string; status: string; taskRef: string }>;
  /** File paths the task touches. */
  files: string[];
  /** Project identifier (e.g. `MYMR`). */
  projectIdentifier: string;
  /** Project display name. */
  projectName: string;
  /** Click an edge target to navigate. */
  onSelectNode: (taskId: string) => void;
  /** Refresh the graph after a mutation. */
  onGraphChange?: () => void;
}

/**
 * Right-rail properties panel — Status + Category dropdowns, Tags editor,
 * Priority/Assignee/Estimate placeholders, Project (read-only), Dependencies
 * split (Depends on / Blocks), and Files Touched.
 *
 * @param props - Rail configuration.
 * @returns Aside element scrollable within the column.
 */
export function PropRail({
  taskId,
  projectId,
  status,
  priority,
  estimate,
  assignees,
  organizationId,
  category,
  categories,
  tags,
  projectTags,
  edges,
  taskMap,
  files,
  projectIdentifier,
  projectName,
  onSelectNode,
  onGraphChange,
}: PropRailProps) {
  // Walk `edges` once and produce both directions plus the pre-mapped
  // DepGroup items. Filtering twice per render — once per direction — was
  // an O(edges) hit on every refetch even when nothing relevant changed.
  // Centralising the pass also gives `DepGroup` a stable `items` prop so a
  // future `React.memo` on the sub-row can short-circuit.
  const {
    dependsOnItems,
    blocksItems,
    totalDeps,
  } = useMemo(() => {
    const dependsOnArr: { edgeId: string; otherId: string }[] = [];
    const blocksArr: { edgeId: string; otherId: string }[] = [];
    for (const e of edges) {
      if (e.edgeType !== 'depends_on') continue;
      if (e.sourceTaskId === taskId) {
        dependsOnArr.push({ edgeId: e.id, otherId: e.targetTaskId });
      } else if (e.targetTaskId === taskId) {
        blocksArr.push({ edgeId: e.id, otherId: e.sourceTaskId });
      }
    }
    return {
      dependsOnItems: dependsOnArr,
      blocksItems: blocksArr,
      totalDeps: dependsOnArr.length + blocksArr.length,
    };
  }, [edges, taskId]);

  // Shared cache-patch helper for every scalar/array property write
  // (status, priority, estimate, category, tags). Cancels any in-flight
  // refetch — `RealtimeBridge` may have invalidated the query from a
  // previous mutation's SSE event, and the resulting refetch is
  // currently in flight; without the cancel, that refetch can complete
  // after our `setQueryData` below and clobber it with stale data.
  //
  // Then writes the patch to both caches the workspace renders from:
  //
  //   - `TaskFull` (drives PropRail's pills and DetailView's body)
  //   - the slim graph (drives TaskRow chips on the structure list)
  //
  // The slim cache only carries a subset of Task fields, but every key
  // in `TaskPatch` is present on both shapes, so the same patch object
  // is safe to spread onto either.
  const queryClient = useQueryClient();
  const applyOptimisticPatch = useCallback((patch: TaskPatch) => {
    const taskKey = taskKeys.detail(projectId, taskId);
    const graphKey = projectKeys.graph(projectId);

    void queryClient.cancelQueries({ queryKey: taskKey });
    void queryClient.cancelQueries({ queryKey: graphKey });

    queryClient.setQueryData<TaskFull>(taskKey, (prev) =>
      prev ? { ...prev, ...patch } : prev,
    );
    queryClient.setQueryData<ProjectGraphSlim>(graphKey, (prev) =>
      prev
        ? {
            ...prev,
            tasks: prev.tasks.map((t) =>
              t.id === taskId ? { ...t, ...patch } : t,
            ),
          }
        : prev,
    );
  }, [projectId, taskId, queryClient]);

  const handleRestoreStatus = useCallback(async (prev: TaskStatus) => {
    applyOptimisticPatch({ status: prev });
    try {
      await updateTask(taskId, { status: prev });
    } finally {
      onGraphChange?.();
    }
  }, [taskId, applyOptimisticPatch, onGraphChange]);

  const { canUndo: canUndoStatus, push: pushStatusUndo, undo: undoStatus } = useUndo<TaskStatus>({
    onUndo: handleRestoreStatus,
    resetOn: taskId,
  });

  const handleStatusChange = useCallback(async (next: TaskStatus) => {
    if (next === status) return;
    pushStatusUndo(status);
    applyOptimisticPatch({ status: next });
    try {
      await updateTask(taskId, { status: next });
    } finally {
      onGraphChange?.();
    }
  }, [taskId, status, pushStatusUndo, applyOptimisticPatch, onGraphChange]);

  const handleCategoryChange = useCallback(async (next: string | null) => {
    applyOptimisticPatch({ category: next });
    try {
      await updateTask(taskId, { category: next });
    } finally {
      onGraphChange?.();
    }
  }, [taskId, applyOptimisticPatch, onGraphChange]);

  const handleTagsChange = useCallback(async (next: string[]) => {
    applyOptimisticPatch({ tags: next });
    try {
      await updateTask(taskId, { tags: next }, true);
    } finally {
      onGraphChange?.();
    }
  }, [taskId, applyOptimisticPatch, onGraphChange]);

  const handlePriorityChange = useCallback(async (next: Priority | null) => {
    applyOptimisticPatch({ priority: next });
    try {
      await updateTask(taskId, { priority: next });
    } finally {
      onGraphChange?.();
    }
  }, [taskId, applyOptimisticPatch, onGraphChange]);

  const handleEstimateChange = useCallback(async (next: Estimate | null) => {
    applyOptimisticPatch({ estimate: next });
    try {
      await updateTask(taskId, { estimate: next });
    } finally {
      onGraphChange?.();
    }
  }, [taskId, applyOptimisticPatch, onGraphChange]);

  // Optimistic assignee updates: rewrite both the task-detail cache
  // (drives PropRail's trigger + name resolution) and the slim graph
  // cache (drives every TaskRow's avatar stack) so every consumer snaps
  // to the new state immediately, without waiting for the round-trip.
  //
  // Three races we have to defeat for the trigger to stop flickering
  // when the user toggles rapidly:
  //
  //   1. **In-flight refetch overwrites our setQueryData.** Every
  //      `updateTask` triggers an SSE `task` event that `RealtimeBridge`
  //      invalidates on. The refetch may complete after our optimistic
  //      write and clobber it with stale server state. We
  //      `cancelQueries` before each optimistic write so any pending
  //      refetch is aborted before we set.
  //   2. **Mid-chain refetch overwrites the latest intent.** Each chain
  //      step's `await updateTask` blocks for the network round-trip.
  //      During that wait, the SSE for the *previous* step's response
  //      can land and trigger a refetch that returns an intermediate
  //      server state. After every chain step we re-apply the latest
  //      intent if more clicks are queued.
  //   3. **Redundant intermediate writes amplify the SSE storm.** Each
  //      mutation fires another SSE event, multiplying the chances of
  //      hitting race #2. `overwriteArrays=true` makes intermediate
  //      states recoverable from any later write, so we skip a chain
  //      step entirely when newer clicks have queued after it.
  const assigneeMutationChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingAssigneeWritesRef = useRef(0);
  const latestAssigneeIntentRef = useRef<string[] | null>(null);

  const applyAssigneesOptimistically = useCallback((nextUserIds: string[]) => {
    const taskKey = taskKeys.detail(projectId, taskId);
    const graphKey = projectKeys.graph(projectId);

    // Resolve the new assignee projection from the team-members cache. If
    // the cache is cold (graph-rooted entry, picker opened before the
    // query resolved), `getQueryData` returns undefined; the safe fall
    // back is to keep `prev.assignees` for unresolved ids so a cold cache
    // cannot drop an assignee.
    const cachedMembers =
      queryClient.getQueryData<MemberView[]>(teamKeys.members(organizationId));
    const memberById = new Map((cachedMembers ?? []).map((m) => [m.userId, m]));

    queryClient.setQueryData<TaskFull>(taskKey, (prev) => {
      if (!prev) return prev;
      const prevById = new Map(prev.assignees.map((a) => [a.userId, a]));
      const nextAssignees: AssigneeRef[] = nextUserIds
        .map((id) => {
          const fromCache = memberById.get(id);
          if (fromCache) {
            return { userId: fromCache.userId, name: fromCache.name, email: fromCache.email };
          }
          return prevById.get(id);
        })
        .filter((a): a is AssigneeRef => a !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name));
      return { ...prev, assignees: nextAssignees };
    });
    queryClient.setQueryData<ProjectGraphSlim>(graphKey, (prev) =>
      prev
        ? {
            ...prev,
            tasks: prev.tasks.map((t) =>
              t.id === taskId
                ? { ...t, assigneeUserIds: nextUserIds, assigneeCount: nextUserIds.length }
                : t,
            ),
          }
        : prev,
    );
  }, [projectId, taskId, organizationId, queryClient]);

  const handleAssigneesChange = useCallback((nextUserIds: string[]) => {
    const taskKey = taskKeys.detail(projectId, taskId);
    const graphKey = projectKeys.graph(projectId);

    // Track latest user intent — re-applied after each mutation lands so
    // an SSE-driven refetch that completed mid-chain can't reveal an
    // intermediate server state.
    latestAssigneeIntentRef.current = nextUserIds;

    // Cancel any in-flight refetch — `RealtimeBridge` may have invalidated
    // the query from a previous mutation's SSE event, and the resulting
    // refetch is currently in flight. Without cancellation, that refetch
    // can complete after our `setQueryData` below and overwrite it.
    void queryClient.cancelQueries({ queryKey: taskKey });
    void queryClient.cancelQueries({ queryKey: graphKey });

    applyAssigneesOptimistically(nextUserIds);

    pendingAssigneeWritesRef.current += 1;
    const myTurn = assigneeMutationChainRef.current.then(async () => {
      try {
        // Skip when newer clicks have queued after this step —
        // `overwriteArrays=true` makes the later write a complete superset
        // so this intermediate call is redundant, and dropping it reduces
        // the SSE storm that drives race #2 above.
        if (pendingAssigneeWritesRef.current > 1) return;
        await updateTask(taskId, { assigneeIds: nextUserIds }, true);
      } finally {
        pendingAssigneeWritesRef.current -= 1;
        if (pendingAssigneeWritesRef.current === 0) {
          // Final mutation drained — let the broker-triggered refetch sync
          // the server's settled view back in.
          latestAssigneeIntentRef.current = null;
          onGraphChange?.();
        } else {
          // More clicks queued: an SSE event from this step's response is
          // about to (or already has) triggered an invalidating refetch
          // that would land an intermediate snapshot on the cache. Cancel
          // it and re-apply the latest intent so the trigger stays at the
          // user's latest selection.
          void queryClient.cancelQueries({ queryKey: taskKey });
          void queryClient.cancelQueries({ queryKey: graphKey });
          const latest = latestAssigneeIntentRef.current;
          if (latest !== null) applyAssigneesOptimistically(latest);
        }
      }
    });
    assigneeMutationChainRef.current = myTurn.catch(() => {});
    return myTurn;
  }, [projectId, taskId, queryClient, onGraphChange, applyAssigneesOptimistically]);

  return (
    <aside
      className="flex h-full min-h-0 flex-col overflow-y-auto border-l border-border bg-base"
      style={{ width: 'var(--rail-w)' }}
    >
      <div className="space-y-5 p-4">
        <RailGroup label="Properties" trailing={<UndoButton canUndo={canUndoStatus} onUndo={undoStatus} />}>
          <RailRow icon={<StatusGlyph status={status} size={11} />} label="Status">
            <StatusDropdown status={status} onChange={handleStatusChange} align="end" />
          </RailRow>

          <RailRow icon={<IconFlag size={11} />} label="Priority">
            <PriorityDropdown priority={priority} onChange={handlePriorityChange} align="end" />
          </RailRow>

          <RailRow icon={<IconUser size={11} />} label="Assignees">
            <AssigneePicker
              organizationId={organizationId}
              assignees={assignees}
              onChange={handleAssigneesChange}
            />
          </RailRow>

          <RailRow icon={<IconTag size={11} />} label="Category">
            <CategoryDropdown
              category={category}
              categories={categories}
              onChange={handleCategoryChange}
              align="end"
            />
          </RailRow>

          <RailRow icon={<IconClock size={11} />} label="Estimate">
            <EstimateDropdown estimate={estimate} onChange={handleEstimateChange} align="end" />
          </RailRow>

          <RailRow icon={<IconBranch size={11} />} label="Project">
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-text-primary" title={projectName}>
              <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-sm" style={{ background: projectColor(projectIdentifier) }} />
              <span className="min-w-0 truncate">{projectName}</span>
            </span>
          </RailRow>
        </RailGroup>

        <RailGroup label="Tags" count={tags.length > 0 ? tags.length : undefined}>
          <TagsEditor tags={tags} vocabulary={projectTags} onChange={handleTagsChange} />
        </RailGroup>

        <RailGroup label="Dependencies" count={totalDeps > 0 ? totalDeps : undefined}>
          <DepGroup
            kind="depends"
            label="Depends on"
            items={dependsOnItems}
            taskMap={taskMap}
            onSelectNode={onSelectNode}
          />
          <DepGroup
            kind="relates"
            label="Blocks"
            items={blocksItems}
            taskMap={taskMap}
            onSelectNode={onSelectNode}
          />
        </RailGroup>

        <RailGroup label="Files touched" count={files.length > 0 ? files.length : undefined}>
          {files.length > 0 ? (
            <ul className="space-y-1">
              {files.map((path) => (
                <FileChip key={path} path={path} />
              ))}
            </ul>
          ) : (
            <p className="font-mono text-[11px] italic text-text-muted">No files yet.</p>
          )}
        </RailGroup>
      </div>
    </aside>
  );
}

interface StatusDropdownProps {
  /** Active status. */
  status: TaskStatus;
  /** Update the status. */
  onChange: (next: TaskStatus) => void;
  /** Panel anchor side — defaults to `start`. */
  align?: 'start' | 'end';
}

/**
 * Status dropdown — pill-styled trigger paired with a list of every status,
 * matching the prototype's `StatusPill` aesthetic.
 *
 * @param props - Dropdown props.
 * @returns Anchored dropdown element.
 */
function StatusDropdown({ status, onChange, align = 'start' }: StatusDropdownProps) {
  const options = useMemo(
    () => STATUS_OPTIONS.map((s) => {
      const meta = STATUS_META[s] ?? STATUS_META.draft;
      return {
        value: s,
        label: meta.label,
        leading: <StatusGlyph status={s} size={11} />,
      };
    }),
    [],
  );

  return (
    <Dropdown
      value={status}
      options={options}
      onChange={onChange}
      align={align}
      ariaLabel="Change status"
      title="Change status"
      renderTrigger={(active, open) => {
        const meta = STATUS_META[active?.value ?? status] ?? STATUS_META.draft;
        return (
          <span
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider transition-all hover:brightness-110"
            style={{
              background: `color-mix(in srgb, ${meta.cssVar} 22%, transparent)`,
              border: `1px solid color-mix(in srgb, ${meta.cssVar} 38%, transparent)`,
              color: meta.cssVar,
            }}
          >
            <StatusGlyph status={active?.value ?? status} size={10} />
            {meta.label}
            <span aria-hidden="true" className="opacity-70 transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
              <IconChevronDown size={9} />
            </span>
          </span>
        );
      }}
    />
  );
}

interface CategoryDropdownProps {
  /** Active category. */
  category: string | null;
  /** Project categories. */
  categories: string[];
  /** Update the category. */
  onChange: (next: string | null) => void;
  /** Panel anchor side — defaults to `start`. */
  align?: 'start' | 'end';
}

/**
 * Category dropdown — chip-styled trigger that anchors a list of project
 * categories plus a "Clear" entry. Supersedes the prior horizontal-scroll
 * tray.
 *
 * @param props - Dropdown props.
 * @returns Anchored dropdown element.
 */
function CategoryDropdown({ category, categories, onChange, align = 'start' }: CategoryDropdownProps) {
  const options = useMemo(() => {
    const items: { value: string; label: string }[] = [
      { value: SENTINEL_CLEAR, label: 'Uncategorized' },
    ];
    for (const cat of categories) items.push({ value: cat, label: cat });
    return items;
  }, [categories]);

  if (categories.length === 0 && !category) {
    return <PlaceholderValue title="No project categories yet"><span>—</span></PlaceholderValue>;
  }

  const selected = category ?? SENTINEL_CLEAR;

  return (
    <Dropdown
      value={selected}
      options={options}
      onChange={(v) => onChange(v === SENTINEL_CLEAR ? null : v)}
      align={align}
      ariaLabel="Change category"
      title="Change category"
      minWidth={180}
      renderTrigger={(_active, open) => (
        <span
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px] font-medium transition-colors ${
            category
              ? 'bg-accent/10 text-accent-light'
              : 'border border-dashed border-border-strong text-text-muted/70'
          }`}
        >
          {category ?? 'Uncategorized'}
          <span aria-hidden="true" className="opacity-70 transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
            <IconChevronDown size={9} />
          </span>
        </span>
      )}
    />
  );
}

interface TagsEditorProps {
  /** Tags currently attached to the task. */
  tags: string[];
  /** Project tag vocabulary. */
  vocabulary: string[];
  /** Update the tag list (replacement, not append). */
  onChange: (next: string[]) => void;
}

/**
 * Multi-select tag editor — current tags render as removable chips, and a
 * trailing "+ Add" trigger opens a popover that lets the operator toggle
 * existing project tags or add a new one.
 *
 * @param props - Editor props.
 * @returns Wrap of chips plus the add control.
 */
function TagsEditor({ tags, vocabulary, onChange }: TagsEditorProps) {
  const tagSet = useMemo(() => new Set(tags), [tags]);

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  const toggleTag = (tag: string) => {
    if (tagSet.has(tag)) onChange(tags.filter((t) => t !== tag));
    else onChange([...tags, tag]);
  };

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || tagSet.has(trimmed)) return;
    onChange([...tags, trimmed]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="group inline-flex items-center gap-1 rounded-md border border-accent/25 bg-accent/10 py-px pl-2 pr-1 font-mono text-[11px] text-accent-light"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            aria-label={`Remove tag ${tag}`}
            className="cursor-pointer rounded p-0.5 text-accent-light/70 transition-colors hover:bg-accent/15 hover:text-accent-light"
          >
            <IconX size={9} />
          </button>
        </span>
      ))}
      <TagAdd
        vocabulary={vocabulary}
        active={tagSet}
        onToggle={toggleTag}
        onCreate={addTag}
      />
    </div>
  );
}

interface TagAddProps {
  /** Project tag vocabulary. */
  vocabulary: string[];
  /** Tags currently attached to the task. */
  active: Set<string>;
  /** Toggle a tag on/off. */
  onToggle: (tag: string) => void;
  /** Create a new tag (also attaches it). */
  onCreate: (tag: string) => void;
}

/**
 * "+ Add" trigger that opens a popover combining a search input with a
 * checklist of every tag in the project vocabulary. Pressing Enter on a
 * non-existing query creates the tag.
 *
 * @param props - Add control props.
 * @returns Inline-flex popover element.
 */
function TagAdd({ vocabulary, active, onToggle, onCreate }: TagAddProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close handler used by every dismissal path. Resets the search box so
  // the next open starts clean — done at the call site instead of in an
  // effect to keep setState out of the effect body.
  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escape);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escape);
      window.clearTimeout(focusTimer);
    };
  }, [open, close]);

  const q = query.trim().toLowerCase();
  const sorted = useMemo(() => [...vocabulary].sort((a, b) => a.localeCompare(b)), [vocabulary]);
  const filtered = q ? sorted.filter((t) => t.toLowerCase().includes(q)) : sorted;
  const exact = q && sorted.some((t) => t.toLowerCase() === q);
  const canCreate = q && !exact;

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-dashed border-border-strong px-1.5 py-px font-mono text-[10px] text-text-muted transition-colors hover:border-border-stronger hover:bg-surface-hover hover:text-text-secondary"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <IconPlus size={9} />
        Add
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="listbox"
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.11, ease: 'easeOut' }}
            className="absolute right-0 top-full z-30 mt-1 w-[200px] overflow-hidden rounded-md border border-border-strong bg-surface-raised shadow-float"
          >
            <div className="border-b border-border bg-base p-1.5">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canCreate) {
                    onCreate(query);
                    setQuery('');
                  }
                }}
                placeholder={vocabulary.length > 0 ? 'Search or create tag…' : 'Create a tag…'}
                className="w-full bg-transparent px-1 font-mono text-[11px] text-text-primary placeholder:text-text-muted/50 outline-none"
              />
            </div>
            <div className="max-h-[220px] overflow-y-auto py-1">
              {filtered.length === 0 && !canCreate && (
                <p className="px-2.5 py-1.5 font-mono text-[11px] italic text-text-muted">
                  No tags yet — type to create one.
                </p>
              )}
              {filtered.map((tag) => {
                const on = active.has(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={() => onToggle(tag)}
                    className={`flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] transition-colors ${
                      on ? 'bg-accent/10 text-accent-light' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border"
                      style={{
                        background: on ? 'var(--color-accent-grad)' : 'transparent',
                        borderColor: on ? 'transparent' : 'var(--color-border-strong)',
                      }}
                    >
                      {on && (
                        <svg width="8" height="8" viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M3 8.5L6.5 12 13 5" stroke="var(--color-base)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <span className="flex-1 truncate">{tag}</span>
                  </button>
                );
              })}
              {canCreate && (
                <button
                  type="button"
                  onClick={() => {
                    onCreate(query);
                    setQuery('');
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 border-t border-border px-2.5 py-1.5 text-left font-mono text-[11px] text-accent-light transition-colors hover:bg-accent/10"
                >
                  <IconPlus size={10} />
                  <span>Create &ldquo;{query.trim()}&rdquo;</span>
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}

interface RailGroupProps {
  /** Group label. */
  label: string;
  /** Optional count rendered next to the label. */
  count?: React.ReactNode;
  /** Optional trailing slot. */
  trailing?: React.ReactNode;
  /** Group body. */
  children: React.ReactNode;
}

/**
 * Mono uppercase group label plus its content.
 *
 * @param props - Group configuration.
 * @returns Group element.
 */
function RailGroup({ label, count, trailing, children }: RailGroupProps) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{label}</span>
        {count != null && <span className="font-mono text-[10px] tabular-nums text-text-faint">{count}</span>}
        <span className="flex-1" />
        {trailing}
      </div>
      {children}
    </div>
  );
}

interface RailRowProps {
  /** Leading icon. */
  icon: React.ReactNode;
  /** Row label. */
  label: string;
  /** Row value. */
  children: React.ReactNode;
}

/**
 * Two-column row inside a rail group — fixed-width label + flexible value.
 *
 * @param props - Row configuration.
 * @returns Row element.
 */
function RailRow({ icon, label, children }: RailRowProps) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="inline-flex w-[88px] shrink-0 items-center gap-1.5 text-[12px] text-text-muted">
        <span aria-hidden="true" className="text-text-faint">{icon}</span>
        {label}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
    </div>
  );
}

interface PlaceholderValueProps {
  /** Tooltip text. */
  title: string;
  /** Slot content. */
  children: React.ReactNode;
  /** Optional extra class. */
  className?: string;
}

/**
 * Placeholder slot for un-wired property fields. Pairs an em-dash with a
 * tooltip explaining that backend wiring is pending.
 *
 * @param props - Placeholder configuration.
 * @returns Inline-flex span with the slot content.
 */
function PlaceholderValue({ title, children, className = '' }: PlaceholderValueProps) {
  return (
    <span
      title={title}
      className={`inline-flex cursor-help items-center gap-1.5 text-[12px] text-text-muted/70 ${className}`}
    >
      {children}
    </span>
  );
}

interface PriorityDropdownProps {
  /** Active priority, or null when unset. */
  priority: Priority | null;
  /** Update the priority (null clears). */
  onChange: (next: Priority | null) => void;
  /** Panel anchor side — defaults to `start`. */
  align?: 'start' | 'end';
}

/**
 * Pill-styled priority dropdown matching the `StatusDropdown` aesthetic.
 * Trigger tint keys to the active priority (danger / blocked / progress /
 * muted); unset renders a dashed border so the slot reads as empty without
 * collapsing.
 *
 * @param props - Dropdown props.
 * @returns Anchored dropdown element.
 */
function PriorityDropdown({ priority, onChange, align = 'start' }: PriorityDropdownProps) {
  const options = useMemo(
    () => {
      const items: DropdownItem[] = PRIORITY_DISPLAY_ORDER.map((p) => ({
        value: p,
        label: p,
        leading: <PriorityIcon priority={p} />,
      }));
      items.push({ value: SENTINEL_CLEAR, label: 'Clear' });
      return items;
    },
    [],
  );

  const selected = priority ?? SENTINEL_CLEAR;

  return (
    <Dropdown
      value={selected}
      options={options}
      onChange={(v) => onChange(v === SENTINEL_CLEAR ? null : (v as Priority))}
      align={align}
      ariaLabel="Change priority"
      title="Change priority"
      minWidth={180}
      renderTrigger={(_active, open) => {
        const tint = priority ? PRIORITY_COLOR[priority] : null;
        if (!tint) {
          return (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border-strong px-2 py-0.5 font-mono text-[10px] font-medium text-text-muted/70 transition-colors hover:border-border-stronger hover:text-text-secondary">
              <PriorityIcon priority={null} />
              <span>None</span>
              <span aria-hidden="true" className="opacity-70 transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
                <IconChevronDown size={9} />
              </span>
            </span>
          );
        }
        return (
          <span
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider transition-all hover:brightness-110"
            style={{
              background: `color-mix(in srgb, ${tint} 22%, transparent)`,
              border: `1px solid color-mix(in srgb, ${tint} 38%, transparent)`,
              color: tint,
            }}
          >
            <PriorityIcon priority={priority} />
            {priority}
            <span aria-hidden="true" className="opacity-70 transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
              <IconChevronDown size={9} />
            </span>
          </span>
        );
      }}
    />
  );
}

interface EstimateDropdownProps {
  /** Active estimate, or null when unset. */
  estimate: Estimate | null;
  /** Update the estimate (null clears). */
  onChange: (next: Estimate | null) => void;
  /** Panel anchor side — defaults to `start`. */
  align?: 'start' | 'end';
}

/**
 * Pill-styled estimate dropdown — renders the active Fibonacci point in
 * mono uppercase, mirroring the StatusDropdown's pill geometry.
 *
 * @param props - Dropdown props.
 * @returns Anchored dropdown element.
 */
function EstimateDropdown({ estimate, onChange, align = 'start' }: EstimateDropdownProps) {
  const options = useMemo(
    () => {
      const items: DropdownItem[] = ESTIMATE_OPTIONS.map((e) => ({
        value: String(e),
        label: `${e} pt`,
      }));
      items.push({ value: SENTINEL_CLEAR, label: 'Clear' });
      return items;
    },
    [],
  );

  const selected = estimate == null ? SENTINEL_CLEAR : String(estimate);

  return (
    <Dropdown
      value={selected}
      options={options}
      onChange={(v) => onChange(v === SENTINEL_CLEAR ? null : (Number(v) as Estimate))}
      align={align}
      ariaLabel="Change estimate"
      title="Change estimate"
      minWidth={140}
      renderTrigger={(_active, open) => {
        if (estimate == null) {
          return (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border-strong px-2 py-0.5 font-mono text-[10px] font-medium text-text-muted/70 transition-colors hover:border-border-stronger hover:text-text-secondary">
              <span>None</span>
              <span aria-hidden="true" className="opacity-70 transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
                <IconChevronDown size={9} />
              </span>
            </span>
          );
        }
        return (
          <span
            className="inline-flex items-center gap-1.5 rounded-md bg-surface-raised px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-text-primary transition-all hover:brightness-110"
            style={{ border: '1px solid var(--color-border-strong)' }}
          >
            {estimate} pt
            <span aria-hidden="true" className="opacity-70 transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
              <IconChevronDown size={9} />
            </span>
          </span>
        );
      }}
    />
  );
}

/** Internal dropdown option shape used by the priority/estimate items. */
type DropdownItem = {
  value: string;
  label: string;
  leading?: React.ReactNode;
};

interface AssigneePickerProps {
  /** Organization UUID — used to fetch the team-member list. */
  organizationId: string;
  /** Active assignees (full projection, includes name/email for the trigger). */
  assignees: AssigneeRef[];
  /** Update the full set of assigned user IDs (replacement, not append). */
  onChange: (nextUserIds: string[]) => void;
}

/**
 * Estimated popover height — search row (~40px) + max list height (260px)
 * + chrome (~4px). Drives the flip-above decision so the panel never falls
 * below the viewport.
 */
const ASSIGNEE_POPOVER_HEIGHT_PX = 304;

/**
 * Avatar-stack trigger anchoring a search + checklist popover of every
 * team member. Mirrors `TagAdd`'s popover shape (click-out / Esc / focus
 * trap) but reads from `listTeamMembersAction` cached under
 * `['team-members', organizationId]` so subsequent opens are instant.
 *
 * @param props - Picker props.
 * @returns Inline-flex trigger + animated popover.
 */
function AssigneePicker({ organizationId, assignees, onChange }: AssigneePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: members, isPending, isError } = useQuery({
    queryKey: teamKeys.members(organizationId),
    queryFn: async () => {
      const result = await listTeamMembersAction({ organizationId });
      if (!result.ok) throw new Error(`list-team-members:${result.code}`);
      return result.data;
    },
    staleTime: 5 * 60_000,
    enabled: open,
  });

  // Fixed-position anchor: escapes the rail's `overflow-y-auto` clipping
  // context so the panel can extend past the rail's left edge without
  // getting cut off by the detail column.
  const { anchor } = usePopoverAnchor({
    open,
    triggerRef,
    align: 'end',
    popoverHeight: ASSIGNEE_POPOVER_HEIGHT_PX,
  });

  // Close handler used by every dismissal path (outside click, Escape, the
  // trigger toggling itself off). Resets the search box so the next open
  // starts clean — done at the call site instead of in an effect to keep
  // setState out of the effect body.
  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const inTrigger = triggerRef.current?.contains(e.target as Node);
      const inPopover = popoverRef.current?.contains(e.target as Node);
      if (!inTrigger && !inPopover) close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escape);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escape);
      window.clearTimeout(focusTimer);
    };
  }, [open, close]);

  // Local source of truth for which members are checked. Rapid clicks
  // need to read the latest intent synchronously, not the prop-derived
  // set that lags behind in-flight mutations. The ref shadows the state
  // so async callbacks read the live value even before React commits the
  // next render.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(assignees.map((a) => a.userId)),
  );
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const pendingMutationsRef = useRef(0);
  // Ticks every time the mutation chain drains, re-triggering the sync
  // effect even when `assignees` hasn't changed shape since the last
  // tick. Without this, a remote teammate's edit that arrives via SSE
  // while `pendingMutationsRef > 0` is silently dropped: the effect
  // bails on the guard, and its `[assignees]` dep already moved on by
  // the time mutations settle.
  const [drainTick, setDrainTick] = useState(0);

  // Sync from props only when no mutations are in flight. Otherwise we
  // race: a settled-but-not-final mutation updates `assignees` to an
  // intermediate state and overwrites the user's latest local intent.
  useEffect(() => {
    if (pendingMutationsRef.current > 0) return;
    setSelectedIds(new Set(assignees.map((a) => a.userId)));
  }, [assignees, drainTick]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!members) return [] as MemberView[];
    if (!q) return members;
    return members.filter((m) =>
      m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
    );
  }, [members, q]);

  const toggleMember = useCallback(async (userId: string) => {
    const next = new Set(selectedIdsRef.current);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    selectedIdsRef.current = next;
    setSelectedIds(next);

    pendingMutationsRef.current += 1;
    try {
      await Promise.resolve(onChange([...next]));
    } finally {
      pendingMutationsRef.current -= 1;
      if (pendingMutationsRef.current === 0) setDrainTick((t) => t + 1);
    }
  }, [onChange]);

  // Pre-sort the trigger avatars by name so they match `TaskRow`'s avatar
  // stack and the server-returned ordering. `assignees` already arrives
  // name-sorted from `fetchAssigneesUnchecked`, but the optimistic write
  // path can write a click-ordered array briefly; sorting on render
  // collapses both states.
  const sortedAssignees = useMemo(
    () => [...assignees].sort((a, b) => a.name.localeCompare(b.name)),
    [assignees],
  );
  const visibleAssignees = sortedAssignees.slice(0, 2);
  const overflowAssignees = sortedAssignees.length - visibleAssignees.length;

  // Flip direction drives both the panel positioning and the enter/exit
  // y-translate so the popover slides toward its anchored edge instead of
  // away from it.
  const flipped = anchor?.vertical === 'above';
  const popoverStyle = anchor ? popoverFixedStyle(anchor) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={sortedAssignees.length === 0 ? 'Add assignees' : 'Edit assignees'}
        className="inline-flex cursor-pointer items-center justify-end gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-surface-hover"
      >
        {sortedAssignees.length === 0 ? (
          // Empty-state placeholder shares the 18px avatar footprint so the
          // trigger keeps a stable width as the user toggles assignees on
          // and off. Matches the TaskRow "Unassigned" affordance; the `+`
          // glyph differentiates this editable trigger from the static
          // row indicator.
          <span
            aria-hidden="true"
            className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-dashed border-border-strong text-text-muted/60 transition-colors hover:border-border-stronger hover:text-text-secondary"
          >
            <IconPlus size={9} />
          </span>
        ) : (
          <span className="inline-flex items-center">
            {visibleAssignees.map((a, i) => {
              const isLastVisible = i === visibleAssignees.length - 1;
              return (
                <span key={a.userId} className={`relative ${i === 0 ? '' : '-ml-2'}`}>
                  <Avatar name={a.name} size={18} />
                  {isLastVisible && overflowAssignees > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute -top-1 -right-1 inline-flex h-[11px] min-w-[11px] items-center justify-center rounded-full border border-border-strong bg-surface-raised px-[2px] font-mono text-[7.5px] font-semibold leading-none text-text-secondary"
                    >
                      +{overflowAssignees}
                    </span>
                  )}
                </span>
              );
            })}
          </span>
        )}
      </button>

      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {open && popoverStyle && (
            <motion.div
              ref={popoverRef}
              role="listbox"
              aria-multiselectable="true"
              initial={{ opacity: 0, y: flipped ? 4 : -4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: flipped ? 4 : -4, scale: 0.97 }}
              transition={{ duration: 0.11, ease: 'easeOut' }}
              style={popoverStyle}
              className="z-50 w-[240px] overflow-hidden rounded-md border border-border-strong bg-surface-raised shadow-float"
            >
              <div className="border-b border-border bg-base p-2">
                <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5">
                  <span aria-hidden="true" className="text-text-muted">
                    <IconSearch size={11} />
                  </span>
                  <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search teammates…"
                    className="w-full bg-transparent px-1.5 py-1 font-mono text-[11px] text-text-primary placeholder:text-text-muted/60 outline-none"
                  />
                </div>
              </div>
              <div className="max-h-[260px] overflow-y-auto py-1">
                {isPending && (
                  <div className="space-y-1 px-1.5 py-1">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="block h-7 animate-pulse rounded bg-surface-hover" />
                    ))}
                  </div>
                )}
                {isError && (
                  <p className="px-2.5 py-1.5 font-mono text-[11px] italic text-text-muted">
                    Failed to load team members.
                  </p>
                )}
                {!isPending && !isError && filtered.length === 0 && (
                  <p className="px-2.5 py-1.5 font-mono text-[11px] italic text-text-muted">
                    No matches.
                  </p>
                )}
                {!isPending && !isError && filtered.map((m) => {
                  const on = selectedIds.has(m.userId);
                  return (
                    <button
                      key={m.userId}
                      type="button"
                      role="option"
                      aria-selected={on}
                      onClick={() => toggleMember(m.userId)}
                      className={`flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left transition-colors ${
                        on ? 'bg-accent/10' : 'hover:bg-surface-hover'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className="inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border"
                        style={{
                          background: on ? 'var(--color-accent-grad)' : 'transparent',
                          borderColor: on ? 'transparent' : 'var(--color-border-strong)',
                        }}
                      >
                        {on && (
                          <svg width="8" height="8" viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M3 8.5L6.5 12 13 5" stroke="var(--color-base)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      <Avatar name={m.name} size={22} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={`truncate text-[12px] ${on ? 'text-accent-light' : 'text-text-primary'}`}>
                          {m.name}
                        </span>
                        <span className="truncate font-mono text-[10px] text-text-muted">
                          {m.email}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

interface DepGroupProps {
  /** Edge type — drives the dot colour. */
  kind: 'depends' | 'relates';
  /** Section label. */
  label: string;
  /** Edge entries. */
  items: { edgeId: string; otherId: string }[];
  /** Map of every task in the project. */
  taskMap: Map<string, { title: string; status: string; taskRef: string }>;
  /** Click a row to navigate. */
  onSelectNode: (taskId: string) => void;
}

/**
 * Sub-group of dependency rows — labelled header plus list of links.
 *
 * @param props - Group configuration.
 * @returns Sub-group element.
 */
function DepGroup({ kind, label, items, taskMap, onSelectNode }: DepGroupProps) {
  if (items.length === 0) return null;
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: kind === 'depends' ? 'var(--color-depends)' : 'var(--color-relates)' }}
        />
        <span className="text-[11px] text-text-muted">{label}</span>
        <span className="font-mono text-[10px] tabular-nums text-text-faint">{items.length}</span>
      </div>
      <ul className="space-y-px">
        {items.map(({ edgeId, otherId }) => {
          const other = taskMap.get(otherId);
          if (!other) return null;
          return (
            <li key={edgeId}>
              <button
                type="button"
                onClick={() => onSelectNode(otherId)}
                className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-hover"
              >
                <StatusGlyph status={other.status} size={11} />
                <MonoId id={other.taskRef} copyable={false} dim />
                <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary group-hover:text-text-primary">
                  {other.title}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface FileChipProps {
  /** File path. */
  path: string;
}

/**
 * Mono file chip — path-only since the schema stores `string[]`. Diff
 * stats wait for a backend shape change.
 *
 * @param props - File chip configuration.
 * @returns Inline-flex chip element.
 */
function FileChip({ path }: FileChipProps) {
  return (
    <li
      className="flex items-center gap-1.5 rounded-md border border-border bg-surface-raised/50 px-2 py-1 font-mono text-[11px] text-text-secondary"
      title={path}
    >
      <span aria-hidden="true" className="text-text-faint">
        <IconDoc size={10} />
      </span>
      <span className="min-w-0 truncate">{path}</span>
    </li>
  );
}

/**
 * Tiny note rendered when a relationship has additional context — kept
 * out of the main row so the chip stays scannable.
 *
 * @param props - Note text.
 * @returns Markdown sub-line.
 */
export function EdgeNote({ note }: { note: string }) {
  return <Markdown className="mt-0.5 pl-1 text-[11px] leading-tight text-text-muted">{note}</Markdown>;
}

export default PropRail;
