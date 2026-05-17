'use client';

import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Markdown } from '@/components/shared/Markdown';
import { MonoId } from '@/components/shared/MonoId';
import { StatusGlyph } from '@/components/shared/StatusGlyph';
import { IconPlus, IconX } from '@/components/shared/icons';
import { createEdge, removeEdge } from '@/lib/graph/mutations';
import type { TaskEdge } from '@/lib/db/schema';
import { SectionHeader } from './SectionHeader';

/** User-facing relationship modes — each maps to an edge type + direction. */
type RelationMode = 'blocked_by' | 'blocks' | 'related_to';

/** Logical direction used to group existing edges into sub-sections. */
type EdgeDirection = 'blocked_by' | 'blocks' | 'related_to';

interface RelationOption {
  /** Mode identifier. */
  mode: RelationMode;
  /** Display label. */
  label: string;
  /** CSS variable carrying the dot/border color. */
  cssVar: string;
}

const RELATION_MODES: readonly RelationOption[] = [
  { mode: 'blocked_by', label: 'Blocked by', cssVar: 'var(--color-depends)' },
  { mode: 'blocks',     label: 'Blocks',     cssVar: 'var(--color-cancelled)' },
  { mode: 'related_to', label: 'Related to', cssVar: 'var(--color-relates)' },
];

const DIRECTION_META: Record<EdgeDirection, { label: string; cssVar: string }> = {
  blocked_by: { label: 'Depends on', cssVar: 'var(--color-depends)' },
  blocks:     { label: 'Blocks',     cssVar: 'var(--color-cancelled)' },
  related_to: { label: 'Related to', cssVar: 'var(--color-relates)' },
};

interface RelationshipsSectionProps {
  /** Current task UUID. */
  taskId: string;
  /** Edges connected to this task. */
  edges: TaskEdge[];
  /** Map of every task in the project. */
  taskMap: Map<string, { title: string; status: string; taskRef: string }>;
  /** Click an edge target to open it. */
  onSelectNode: (taskId: string) => void;
  /** Refresh the graph after a mutation. */
  onGraphChange?: () => void;
}

interface DirectionalEdge {
  /** Edge UUID. */
  id: string;
  /** Direction relative to the current task. */
  direction: EdgeDirection;
  /** UUID of the other end. */
  otherId: string;
  /** Optional inline note from the edge. */
  note: string | null;
}

/**
 * Bucket an edge into a directional group relative to the current task.
 *
 * @param edge - Edge to classify.
 * @param taskId - Current task UUID.
 * @returns Direction key.
 */
function directionFor(edge: TaskEdge, taskId: string): EdgeDirection {
  if (edge.edgeType === 'relates_to') return 'related_to';
  return edge.sourceTaskId === taskId ? 'blocked_by' : 'blocks';
}

/**
 * Relationships section — directional edge list grouped by relation kind
 * with inline create / delete. Uses a portal-rendered dropdown for the
 * search so it escapes the detail column's `overflow:hidden` ancestor.
 *
 * @param props - Section configuration.
 * @returns Section element with grouped edge lists and add form.
 */
export function RelationshipsSection({ taskId, edges, taskMap, onSelectNode, onGraphChange }: RelationshipsSectionProps) {
  const [adding, setAdding] = useState(false);
  const [relation, setRelation] = useState<RelationMode>('blocked_by');
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [prevTaskId, setPrevTaskId] = useState(taskId);
  const searchRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  if (taskId !== prevTaskId) {
    setPrevTaskId(taskId);
    setAdding(false);
    setError(null);
    setSelectedTarget(null);
    setNote('');
    setSearch('');
  }

  useEffect(() => { if (adding) searchRef.current?.focus(); }, [adding]);
  useEffect(() => { if (selectedTarget) noteRef.current?.focus(); }, [selectedTarget]);

  const grouped = useMemo<Record<EdgeDirection, DirectionalEdge[]>>(() => {
    const out: Record<EdgeDirection, DirectionalEdge[]> = { blocked_by: [], blocks: [], related_to: [] };
    for (const edge of edges) {
      const direction = directionFor(edge, taskId);
      const otherId = edge.sourceTaskId === taskId ? edge.targetTaskId : edge.sourceTaskId;
      out[direction].push({ id: edge.id, direction, otherId, note: edge.note ?? null });
    }
    return out;
  }, [edges, taskId]);

  const connectedIds = new Set(edges.map((e) => (e.sourceTaskId === taskId ? e.targetTaskId : e.sourceTaskId)));

  const candidates = Array.from(taskMap.entries())
    .filter(([id]) => id !== taskId && !connectedIds.has(id))
    .filter(([, t]) => !search || t.title.toLowerCase().includes(search.toLowerCase()) || t.taskRef.toLowerCase().includes(search.toLowerCase()));

  const dropdownOpen = adding && !selectedTarget && search.length > 0;

  useLayoutEffect(() => {
    if (!dropdownOpen) return;
    const update = () => {
      const rect = searchRef.current?.getBoundingClientRect();
      if (rect) setAnchorRect(rect);
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [dropdownOpen, candidates.length]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inAnchor = dropdownRef.current?.contains(target);
      const inPortal = portalRef.current?.contains(target);
      if (!inAnchor && !inPortal) setSearch('');
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const resetForm = () => {
    setAdding(false);
    setSelectedTarget(null);
    setNote('');
    setSearch('');
    setRelation('blocked_by');
    setError(null);
  };

  const handleSubmit = async () => {
    if (!selectedTarget || submitting) return;
    const trimmedNote = note.trim();
    if (!trimmedNote) {
      setError('Note is required — describe why this relationship exists');
      noteRef.current?.focus();
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const isBlocks = relation === 'blocks';
      await createEdge({
        sourceTaskId: isBlocks ? selectedTarget : taskId,
        targetTaskId: isBlocks ? taskId : selectedTarget,
        edgeType: relation === 'related_to' ? 'relates_to' : 'depends_on',
        note: trimmedNote,
      });
      resetForm();
      onGraphChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create edge');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (edgeId: string) => {
    await removeEdge(edgeId);
    onGraphChange?.();
  };

  const totalEdges = edges.length;

  return (
    <section className="mb-7">
      <SectionHeader
        label="Relationships"
        count={totalEdges > 0 ? totalEdges : undefined}
        trailing={!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors hover:border-border-strong hover:text-text-secondary"
            aria-label="Add relationship"
          >
            <IconPlus size={10} />
            Add
          </button>
        )}
      />

      <div className="space-y-3">
        {(['blocked_by', 'blocks', 'related_to'] as const).map((direction) => {
          const items = grouped[direction];
          if (items.length === 0) return null;
          const meta = DIRECTION_META[direction];
          return (
            <DirectionGroup
              key={direction}
              label={meta.label}
              cssVar={meta.cssVar}
              count={items.length}
            >
              {items.map((edge) => {
                const other = taskMap.get(edge.otherId);
                if (!other) return null;
                return (
                  <RelationshipRow
                    key={edge.id}
                    taskRef={other.taskRef}
                    title={other.title}
                    status={other.status}
                    note={edge.note}
                    onSelect={() => onSelectNode(edge.otherId)}
                    onDelete={() => handleDelete(edge.id)}
                  />
                );
              })}
            </DirectionGroup>
          );
        })}

        {totalEdges === 0 && !adding && (
          <p className="font-mono text-[11px] italic text-text-muted">
            No relationships yet — link upstream deps, blocked tasks, or siblings.
          </p>
        )}
      </div>

      {adding && (
        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface-raised/40">
          <div className="flex gap-1 border-b border-border bg-base-2 p-1">
            {RELATION_MODES.map(({ mode, label, cssVar }) => {
              const active = relation === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setRelation(mode)}
                  className={`flex-1 cursor-pointer rounded-md px-2 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] transition-all ${
                    active ? 'bg-surface' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'
                  }`}
                  style={
                    active
                      ? { color: cssVar, boxShadow: `inset 0 -2px 0 0 ${cssVar}` }
                      : undefined
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="space-y-2 p-3">
            <div ref={dropdownRef} className="relative">
              <input
                ref={searchRef}
                type="text"
                value={selectedTarget ? (taskMap.get(selectedTarget)?.title ?? '') : search}
                onChange={(e) => { setSearch(e.target.value); setSelectedTarget(null); setError(null); }}
                onFocus={() => { if (selectedTarget) { setSearch(taskMap.get(selectedTarget)?.title ?? ''); setSelectedTarget(null); } }}
                onKeyDown={(e) => { if (e.key === 'Escape') resetForm(); }}
                placeholder="Search tasks…"
                className="w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[12px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent"
              />
              {dropdownOpen && anchorRect && typeof window !== 'undefined' && createPortal(
                <div
                  ref={portalRef}
                  style={{
                    position: 'fixed',
                    left: anchorRect.left,
                    top: anchorRect.bottom + 4,
                    width: anchorRect.width,
                    zIndex: 50,
                  }}
                  className="max-h-[180px] overflow-y-auto rounded-md border border-border bg-surface shadow-[var(--shadow-float)]"
                >
                  {candidates.length > 0 ? (
                    candidates.slice(0, 8).map(([id, t]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => { setSelectedTarget(id); setSearch(''); setError(null); }}
                        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover"
                      >
                        <StatusGlyph status={t.status} size={11} />
                        <MonoId id={t.taskRef} copyable={false} dim />
                        <span className="min-w-0 truncate text-[12px] text-text-secondary">{t.title}</span>
                      </button>
                    ))
                  ) : (
                    <div className="px-2.5 py-2 text-[11px] text-text-muted">No matching tasks</div>
                  )}
                </div>,
                document.body,
              )}
            </div>

            {selectedTarget && (
              <input
                ref={noteRef}
                type="text"
                value={note}
                onChange={(e) => { setNote(e.target.value); if (error) setError(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSubmit();
                  if (e.key === 'Escape') resetForm();
                }}
                placeholder="Why does this relationship exist?"
                maxLength={255}
                className="w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[12px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent"
              />
            )}

            {error && <p className="text-[11px] text-danger">{error}</p>}

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!selectedTarget || submitting}
                className="cursor-pointer rounded-md border border-accent/30 bg-accent/15 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-light transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? 'Adding…' : 'Add'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="cursor-pointer rounded-md px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

interface DirectionGroupProps {
  /** Sub-group label. */
  label: string;
  /** Color used for the leading dot. */
  cssVar: string;
  /** Number of edges in this direction. */
  count: number;
  /** Group rows. */
  children: React.ReactNode;
}

/**
 * Sub-group inside the Relationships section — colored dot + mono label
 * + count, then the rows. Mirrors the PropRail Dependencies aesthetic.
 *
 * @param props - Group configuration.
 * @returns Sub-group element.
 */
function DirectionGroup({ label, cssVar, count, children }: DirectionGroupProps) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ background: cssVar }} />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">{label}</span>
        <span className="font-mono text-[10px] tabular-nums text-text-faint">{count}</span>
      </div>
      <ul className="space-y-px">{children}</ul>
    </div>
  );
}

interface RelationshipRowProps {
  /** Target task identifier. */
  taskRef: string;
  /** Target task title. */
  title: string;
  /** Target task status. */
  status: string;
  /** Optional edge note. */
  note: string | null;
  /** Click the row to open the target. */
  onSelect: () => void;
  /** Remove the edge. */
  onDelete: () => void;
}

/**
 * Single relationship row — status glyph + mono id + title, with an
 * inline delete affordance that fades in on hover.
 *
 * @param props - Row configuration.
 * @returns List item element.
 */
function RelationshipRow({ taskRef, title, status, note, onSelect, onDelete }: RelationshipRowProps) {
  return (
    <li className="group/edge -mx-1 rounded-md px-1.5 py-1 transition-colors hover:bg-surface-hover">
      <div className="flex items-center gap-2">
        <StatusGlyph status={status} size={11} />
        <MonoId id={taskRef} copyable={false} dim />
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 cursor-pointer truncate text-left text-[12px] text-text-secondary transition-colors hover:text-text-primary"
        >
          {title}
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Remove relationship"
          className="shrink-0 cursor-pointer rounded p-0.5 text-text-muted opacity-0 transition-all hover:text-danger group-hover/edge:opacity-100"
        >
          <IconX size={11} />
        </button>
      </div>
      {note && (
        <Markdown className="mt-0.5 pl-[26px] text-[11px] leading-snug text-text-muted">{note}</Markdown>
      )}
    </li>
  );
}

export default RelationshipsSection;
