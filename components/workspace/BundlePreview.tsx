'use client';

import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Markdown } from '@/components/shared/Markdown';
import { MonoId } from '@/components/shared/MonoId';
import { StatusGlyph } from '@/components/shared/StatusGlyph';
import { CopyButton } from '@/components/shared/CopyButton';
import { IconBundle, IconChevronRight } from '@/components/shared/icons';
import type { AcceptanceCriterion, Decision, TaskStatus } from '@/lib/types';
import { taskKeys } from '@/lib/query/keys';
import { fetchTaskContext } from '@/lib/query/queries';

/** Resolved bundle stage — adds derived `plannable` and `ready` sub-stages. */
type BundleStage = 'draft' | 'plannable' | 'planned' | 'ready' | 'in_progress' | 'done' | 'cancelled';

/** Section identifiers — also used as React keys. */
type SectionId =
  | 'spec'
  | 'criteria'
  | 'plan'
  | 'prerequisites'
  | 'neighbors'
  | 'decisions'
  | 'files'
  | 'downstream'
  | 'execution';

interface BundleSectionMeta {
  /** Stable identifier. */
  id: SectionId;
  /** Mono uppercase label rendered in the section header. */
  label: string;
  /** CSS color used for the left strip and bar slice. */
  color: string;
}

/** Section metadata table — color cues match DESIGN.md §3.9. */
const SECTION_META: Record<SectionId, BundleSectionMeta> = {
  spec:          { id: 'spec',          label: 'spec',          color: 'var(--color-accent-light)' },
  criteria:      { id: 'criteria',      label: 'criteria',      color: 'var(--color-accent-light)' },
  plan:          { id: 'plan',          label: 'plan',          color: 'var(--color-accent)' },
  prerequisites: { id: 'prerequisites', label: 'prerequisites', color: 'var(--color-done)' },
  neighbors:     { id: 'neighbors',     label: 'neighbors',     color: 'var(--color-accent-2)' },
  decisions:     { id: 'decisions',     label: 'decisions',     color: 'var(--color-accent)' },
  files:         { id: 'files',         label: 'files',         color: 'var(--color-progress)' },
  downstream:    { id: 'downstream',    label: 'downstream',    color: 'var(--color-relates)' },
  execution:     { id: 'execution',     label: 'execution',     color: 'var(--color-done)' },
};

/**
 * Section list per stage — mirrors what each `lib/context/_core/*` builder
 * actually emits in the order the agent receives. U-shaped attention puts
 * the spec first and downstream last so the model anchors on inputs and
 * exits on consumers.
 *
 * - `draft` → planning context with no prereqs yet (`planning.ts`)
 * - `plannable` (derived: draft with criteria + done deps) → `planning.ts`
 * - `planned` → `working.ts` 1-hop shape (criteria → decisions → connected)
 * - `ready` (derived: planned + all deps done) → `planning.ts` shape with plan
 * - `in_progress` → `agent.ts` lean execution shape
 * - `done` / `cancelled` → execution record on top, artefacts below
 */
const SHAPE_BY_STAGE: Record<BundleStage, readonly SectionId[]> = {
  draft:       ['spec', 'criteria'],
  plannable:   ['spec', 'criteria', 'prerequisites', 'decisions', 'downstream'],
  planned:     ['spec', 'criteria', 'decisions', 'prerequisites', 'neighbors'],
  ready:       ['spec', 'criteria', 'plan', 'prerequisites', 'decisions', 'downstream'],
  in_progress: ['spec', 'plan', 'prerequisites', 'decisions', 'criteria', 'files', 'downstream'],
  done:        ['execution', 'spec', 'criteria', 'files', 'downstream'],
  cancelled:   ['execution'],
};

/** Bundle name shown in the preview header — matches the `lib/context` builder that runs at this stage. */
const BUNDLE_NAME: Record<BundleStage, string> = {
  draft:       'planning bundle',
  plannable:   'planning bundle',
  planned:     'working bundle',
  ready:       'planning bundle',
  in_progress: 'agent bundle',
  done:        'execution record',
  cancelled:   'execution record',
};

/** Which raw bundle string powers the MD toggle for each stage. */
const BUNDLE_SOURCE: Record<BundleStage, 'agent' | 'planning' | 'working' | 'execution'> = {
  draft:       'planning',
  plannable:   'planning',
  planned:     'working',
  ready:       'planning',
  in_progress: 'agent',
  done:        'execution',
  cancelled:   'execution',
};

interface BundleNeighbor {
  /** Task UUID. */
  id: string;
  /** Composed task identifier (e.g. `MYMR-104`). */
  taskRef: string;
  /** Display title. */
  title: string;
  /** Schema status. */
  status: string;
}

interface BundlePreviewProps {
  /** Task UUID — used by the lazy bundle fetch. */
  taskId: string;
  /** Project UUID — used by the lazy bundle fetch's query key. */
  projectId: string;
  /** Task status — drives the section shape. */
  status: TaskStatus;
  /** Whether the task is derived-ready (planned + all deps done). */
  isReady: boolean;
  /** Whether the task is a plannable draft (description + criteria + done deps). */
  isPlannable: boolean;
  /** Task spec (description). */
  spec: string;
  /** Acceptance criteria — drives the criteria section. */
  criteria: AcceptanceCriterion[];
  /** Implementation plan markdown — drives the plan section. */
  plan: string | null;
  /** Upstream `depends_on` task neighbors. */
  prerequisites: BundleNeighbor[];
  /** Sibling `relates_to` task neighbors. */
  neighbors: BundleNeighbor[];
  /** Downstream `depends_on` consumers. */
  downstream: BundleNeighbor[];
  /** Pinned decisions. */
  decisions: Decision[];
  /** File paths the task touches. */
  files: string[];
  /** Execution record markdown. */
  executionRecord: string | null;
  /** Click a neighbor row to navigate to that task. */
  onSelectTask?: (taskId: string) => void;
}

/**
 * Resolve the visible bundle stage from DB status plus the derived
 * `isReady` and `isPlannable` flags so the preview reflects what the agent
 * would get if picked up right now:
 *
 * - `planned` whose effective deps are done → `ready`
 * - `draft` with description + criteria + done deps → `plannable`
 *
 * @param status - DB status of the task.
 * @param isReady - Derived-ready flag from `lib/ui/taskState`.
 * @param isPlannable - Derived-plannable flag from `lib/ui/taskState`.
 * @returns Resolved bundle stage.
 */
function resolveStage(status: TaskStatus, isReady: boolean, isPlannable: boolean): BundleStage {
  if (status === 'planned' && isReady) return 'ready';
  if (status === 'draft' && isPlannable) return 'plannable';
  return status;
}

/**
 * Approximate visual weight of a section so the proportional bar reflects
 * the section's relative size without exposing a token number to the user.
 *
 * @param id - Section identifier.
 * @param props - Bundle props supplying the underlying data.
 * @returns Non-negative weight (1 minimum so the slice still renders).
 */
function sectionWeight(id: SectionId, props: BundlePreviewProps): number {
  const len = (s: string) => s.length;
  if (id === 'spec') return Math.max(len(props.spec), 1);
  if (id === 'criteria') {
    return Math.max(props.criteria.reduce((sum, c) => sum + len(c.text), 0), 1);
  }
  if (id === 'plan') return Math.max(len(props.plan ?? ''), 1);
  if (id === 'prerequisites') {
    return Math.max(props.prerequisites.reduce((sum, n) => sum + len(`${n.taskRef} ${n.title}`), 0), 1);
  }
  if (id === 'neighbors') {
    return Math.max(props.neighbors.reduce((sum, n) => sum + len(`${n.taskRef} ${n.title}`), 0), 1);
  }
  if (id === 'decisions') {
    return Math.max(props.decisions.reduce((sum, d) => sum + len(d.text), 0), 1);
  }
  if (id === 'files') return Math.max(len(props.files.join('\n')), 1);
  if (id === 'downstream') {
    return Math.max(props.downstream.reduce((sum, n) => sum + len(`${n.taskRef} ${n.title}`), 0), 1);
  }
  return Math.max(len(props.executionRecord ?? ''), 1);
}

/**
 * Collapsible bundle preview — shows the working bundle the agent would
 * receive when picking up the task. Section list adapts to the task's
 * current stage so the preview tracks the real `lib/context/_core/*`
 * builder output.
 *
 * @param props - Bundle data.
 * @returns Card containing the header, section bar, and section list.
 */
export function BundlePreview(props: BundlePreviewProps) {
  const {
    taskId,
    projectId,
    status,
    isReady,
    isPlannable,
    executionRecord,
    onSelectTask,
  } = props;

  const stage = resolveStage(status, isReady, isPlannable);
  const sectionIds = SHAPE_BY_STAGE[stage];
  const bundleName = BUNDLE_NAME[stage];

  const [expanded, setExpanded] = useState<Set<SectionId>>(() => new Set<SectionId>([sectionIds[0]]));
  const [showRaw, setShowRaw] = useState(false);

  const qc = useQueryClient();
  const { data: bundles, isFetching: bundlesFetching } = useQuery({
    queryKey: taskKeys.context(projectId, taskId),
    queryFn: fetchTaskContext(qc, projectId, taskId),
    enabled: showRaw,
  });

  const rawText = useMemo(() => {
    const source = BUNDLE_SOURCE[stage];
    if (source === 'execution') return executionRecord ?? '';
    return bundles?.[source] ?? '';
  }, [stage, bundles, executionRecord]);

  const weights = useMemo(() => {
    const out = {} as Record<SectionId, number>;
    for (const id of sectionIds) out[id] = sectionWeight(id, props);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, props.spec, props.criteria, props.plan, props.prerequisites,
      props.neighbors, props.decisions, props.files, props.downstream,
      props.executionRecord]);

  /** Toggle a section's expansion state without disturbing the others. */
  const toggle = (id: SectionId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border bg-surface-raised/60 px-3.5 py-2.5">
        <span className="inline-flex text-accent-light">
          <IconBundle size={14} />
        </span>
        <span className="text-[12px] font-medium text-text-primary">{bundleName}</span>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className={`cursor-pointer rounded-md border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors ${
            showRaw
              ? 'border-accent/30 bg-accent/10 text-accent-light'
              : 'border-border-strong text-text-muted hover:bg-surface-hover hover:text-text-secondary'
          }`}
          aria-pressed={showRaw}
          title="Toggle raw markdown view"
        >
          MD
        </button>
      </div>

      <div className="flex h-[6px] w-full bg-base-2">
        {sectionIds.map((id) => (
          <div
            key={id}
            style={{
              flexGrow: weights[id],
              flexBasis: 0,
              background: SECTION_META[id].color,
              opacity: 0.85,
            }}
            aria-hidden="true"
          />
        ))}
      </div>

      {showRaw ? (
        <div className="space-y-2 bg-base-2 p-3">
          <div className="flex items-center justify-end">
            <CopyButton text={rawText} label="Copy" />
          </div>
          <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11.5px] leading-relaxed text-text-secondary">
            {bundlesFetching && !rawText
              ? '// loading bundle…'
              : rawText.trim().length > 0
                ? rawText
                : '// bundle empty — add a description and prerequisites'}
          </pre>
        </div>
      ) : (
        <div>
          {sectionIds.map((id, i) => (
            <BundleSection
              key={id}
              id={id}
              open={expanded.has(id)}
              isLast={i === sectionIds.length - 1}
              onToggle={() => toggle(id)}
              props={props}
              onSelectTask={onSelectTask}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface BundleSectionProps {
  /** Section identifier. */
  id: SectionId;
  /** Whether the section body is expanded. */
  open: boolean;
  /** True for the last section so we can suppress the divider. */
  isLast: boolean;
  /** Toggle the open state. */
  onToggle: () => void;
  /** Bundle props (data sources). */
  props: BundlePreviewProps;
  /** Click a neighbor row to navigate. */
  onSelectTask?: (taskId: string) => void;
}

/**
 * Render the header row plus, when open, the section body. The body chooses
 * its layout from the section id.
 *
 * @param section - Section configuration.
 * @returns Section element with header and animated body.
 */
function BundleSection({ id, open, isLast, onToggle, props, onSelectTask }: BundleSectionProps) {
  const meta = SECTION_META[id];
  const summary = sectionSummary(id, props);

  return (
    <div className={isLast ? '' : 'border-b border-border'}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-raised/40"
      >
        <span aria-hidden="true" className="h-[18px] w-1 rounded-sm" style={{ background: meta.color }} />
        <span className="w-[100px] shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {meta.label}
        </span>
        <span className="flex-1 truncate text-[12px] text-text-primary">
          {summary}
        </span>
        <span
          aria-hidden="true"
          className="inline-flex text-text-faint transition-transform duration-150"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
        >
          <IconChevronRight size={11} />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="bg-base-2 pt-1 pb-3.5 pr-3.5 pl-8">
              <SectionBody id={id} props={props} onSelectTask={onSelectTask} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * One-line summary shown next to the section header — adapts per section.
 *
 * @param id - Section identifier.
 * @param props - Bundle props.
 * @returns Plain text summary line.
 */
function sectionSummary(id: SectionId, props: BundlePreviewProps): string {
  if (id === 'spec') return 'task spec';
  if (id === 'criteria') {
    const total = props.criteria.length;
    if (total === 0) return 'no acceptance criteria';
    const checked = props.criteria.filter((c) => c.checked).length;
    return `${checked} / ${total} criteria`;
  }
  if (id === 'plan') {
    return props.plan && props.plan.trim().length > 0 ? 'implementation plan' : 'no plan yet';
  }
  if (id === 'prerequisites') {
    if (props.prerequisites.length === 0) return 'no upstream deps';
    const refs = props.prerequisites.slice(0, 2).map((p) => p.taskRef).join(' · ');
    return props.prerequisites.length > 2 ? `${refs} · +${props.prerequisites.length - 2} more` : refs;
  }
  if (id === 'neighbors') {
    if (props.neighbors.length === 0) return 'no 1-hop neighbors';
    const refs = props.neighbors.slice(0, 3).map((p) => p.taskRef).join(' · ');
    return props.neighbors.length > 3 ? `${refs} · +${props.neighbors.length - 3} more` : refs;
  }
  if (id === 'decisions') {
    return props.decisions.length === 1 ? '1 decision' : `${props.decisions.length} decisions`;
  }
  if (id === 'files') {
    if (props.files.length === 0) return 'no files yet';
    return props.files.length === 1 ? props.files[0] : `${props.files[0]} + ${props.files.length - 1} more`;
  }
  if (id === 'downstream') {
    if (props.downstream.length === 0) return 'no consumers';
    const refs = props.downstream.slice(0, 2).map((p) => p.taskRef).join(' · ');
    return props.downstream.length > 2 ? `${refs} · +${props.downstream.length - 2} more` : refs;
  }
  return props.executionRecord && props.executionRecord.trim().length > 0
    ? 'shipped record'
    : 'no execution record yet';
}

interface SectionBodyProps {
  /** Section identifier. */
  id: SectionId;
  /** Bundle props. */
  props: BundlePreviewProps;
  /** Click a neighbor row to navigate. */
  onSelectTask?: (taskId: string) => void;
}

/**
 * Section body dispatcher — chooses the right renderer for the active id.
 *
 * @param body - Body configuration.
 * @returns The matching body renderer.
 */
function SectionBody({ id, props, onSelectTask }: SectionBodyProps) {
  if (id === 'spec') return <MarkdownBody text={props.spec} emptyHint="No spec yet — add a description above." />;
  if (id === 'criteria') return <CriteriaBody criteria={props.criteria} />;
  if (id === 'plan') return <MarkdownBody text={props.plan ?? ''} emptyHint="No implementation plan yet." />;
  if (id === 'prerequisites') {
    return <NeighborList items={props.prerequisites} emptyHint="No upstream dependencies." onSelectTask={onSelectTask} />;
  }
  if (id === 'neighbors') {
    return <NeighborList items={props.neighbors} emptyHint="No 1-hop neighbors." onSelectTask={onSelectTask} />;
  }
  if (id === 'decisions') return <DecisionsBody decisions={props.decisions} />;
  if (id === 'files') return <FilesBody files={props.files} />;
  if (id === 'downstream') {
    return <NeighborList items={props.downstream} emptyHint="No downstream consumers." onSelectTask={onSelectTask} />;
  }
  return <MarkdownBody text={props.executionRecord ?? ''} emptyHint="No execution record yet — populated when the task ships." />;
}

interface MarkdownBodyProps {
  /** Markdown text. */
  text: string;
  /** Italic hint shown when empty. */
  emptyHint: string;
}

/**
 * Render a markdown chunk — falls back to an italic mono hint when empty.
 *
 * @param props - Markdown body props.
 * @returns Markdown body or italic empty state.
 */
function MarkdownBody({ text, emptyHint }: MarkdownBodyProps) {
  if (!text.trim()) {
    return <p className="font-mono text-[11.5px] italic text-text-muted">{emptyHint}</p>;
  }
  return <Markdown className="text-[12.5px] leading-relaxed text-text-secondary">{text}</Markdown>;
}

interface CriteriaBodyProps {
  /** Acceptance criteria. */
  criteria: AcceptanceCriterion[];
}

/**
 * Compact acceptance-criteria list — checkbox visual, line-through when checked.
 *
 * @param props - Criteria entries.
 * @returns List or empty hint.
 */
function CriteriaBody({ criteria }: CriteriaBodyProps) {
  if (criteria.length === 0) {
    return <p className="font-mono text-[11.5px] italic text-text-muted">No acceptance criteria yet.</p>;
  }
  return (
    <ul className="space-y-1">
      {criteria.map((c) => (
        <li key={c.id} className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className="mt-[3px] inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border"
            style={{
              background: c.checked ? 'var(--color-accent-grad)' : 'transparent',
              borderColor: c.checked ? 'transparent' : 'var(--color-border-strong)',
            }}
          >
            {c.checked && (
              <svg width="8" height="8" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 8.5L6.5 12 13 5" stroke="var(--color-base)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
          <span
            className={`text-[12.5px] leading-snug ${c.checked ? 'text-text-muted line-through decoration-text-faint' : 'text-text-secondary'}`}
          >
            {c.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface NeighborListProps {
  /** Neighbor task entries. */
  items: BundleNeighbor[];
  /** Italic hint shown when the list is empty. */
  emptyHint: string;
  /** Click a row to navigate. */
  onSelectTask?: (taskId: string) => void;
}

/**
 * Tight list of neighbor tasks: glyph + MonoId + title. Each row is a
 * navigable button when an `onSelectTask` handler is provided.
 *
 * @param props - Neighbor list configuration.
 * @returns Stack of neighbor rows or empty hint.
 */
function NeighborList({ items, emptyHint, onSelectTask }: NeighborListProps) {
  if (items.length === 0) {
    return <p className="font-mono text-[11.5px] italic text-text-muted">{emptyHint}</p>;
  }
  return (
    <ul className="space-y-1">
      {items.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            onClick={() => onSelectTask?.(n.id)}
            className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-hover"
          >
            <StatusGlyph status={n.status} size={11} />
            <MonoId id={n.taskRef} copyable={false} dim />
            <span className="flex-1 truncate text-[12px] text-text-secondary group-hover:text-text-primary">
              {n.title}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface DecisionsBodyProps {
  /** Decision entries. */
  decisions: Decision[];
}

/**
 * Compact decisions list — one line of body text per entry, with the date
 * pinned to the right in mono so the agent sees age at a glance.
 *
 * @param props - Decision entries.
 * @returns Stack of decision rows or empty hint.
 */
function DecisionsBody({ decisions }: DecisionsBodyProps) {
  if (decisions.length === 0) {
    return <p className="font-mono text-[11.5px] italic text-text-muted">No pinned decisions.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {decisions.map((d) => (
        <li key={d.id} className="flex items-start gap-2">
          <span aria-hidden="true" className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] leading-snug text-text-secondary">{d.text}</p>
            <span className="font-mono text-[10px] text-text-faint">{d.date}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

interface FilesBodyProps {
  /** File paths the task touches. */
  files: string[];
}

/**
 * File list — renders each path as a mono chip. Diff stats are deferred
 * until the schema persists `{path, added, removed, commit}` shapes.
 *
 * @param props - Files list.
 * @returns Wrap of file chips or empty hint.
 */
function FilesBody({ files }: FilesBodyProps) {
  if (files.length === 0) {
    return <p className="font-mono text-[11.5px] italic text-text-muted">No files touched yet.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {files.map((path) => (
        <li
          key={path}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-[11px] text-text-secondary"
          title={path}
        >
          {path}
        </li>
      ))}
    </ul>
  );
}

export default BundlePreview;
