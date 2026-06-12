"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Markdown } from "@/components/shared/Markdown";
import { MonoId } from "@/components/shared/MonoId";
import { StatusGlyph } from "@/components/shared/StatusGlyph";
import { CopyButton } from "@/components/shared/CopyButton";
import { IconBundle, IconChevronRight } from "@/components/shared/icons";
import type { AcceptanceCriterion, Decision, TaskStatus } from "@/lib/types";
import type { TaskState } from "@/lib/data/task";
import type { AssigneeRef, TaskLinkRef } from "@/lib/data/views";
import type { BundlePart, BundleSectionId } from "@/lib/context/parts";
import {
  BUNDLE_BY_STAGE,
  BUNDLE_LABEL_BY_STAGE,
  SECTIONS_BY_BUNDLE,
  SERVER_ONLY_SECTIONS,
  resolveStage,
  variantOf,
} from "@/components/workspace/bundle-tables";
import { taskKeys } from "@/lib/query/keys";
import { fetchTaskContext } from "@/lib/query/queries";

interface BundleSectionMeta {
  /** Stable identifier. */
  id: BundleSectionId;
  /** Mono uppercase label rendered in the section header. */
  label: string;
  /** CSS color used for the left strip and bar slice. */
  color: string;
}

/** Section metadata table — color cues match DESIGN.md §3.9. */
const SECTION_META: Record<BundleSectionId, BundleSectionMeta> = {
  spec: { id: "spec", label: "spec", color: "var(--color-accent-light)" },
  meta: { id: "meta", label: "meta", color: "var(--color-planned)" },
  criteria: {
    id: "criteria",
    label: "criteria",
    color: "var(--color-accent-light)",
  },
  plan: { id: "plan", label: "plan", color: "var(--color-accent)" },
  prerequisites: {
    id: "prerequisites",
    label: "prerequisites",
    color: "var(--color-done)",
  },
  built: { id: "built", label: "built", color: "var(--color-done)" },
  abandoned: {
    id: "abandoned",
    label: "abandoned",
    color: "var(--color-cancelled)",
  },
  decisions: {
    id: "decisions",
    label: "decisions",
    color: "var(--color-accent)",
  },
  constraints: {
    id: "constraints",
    label: "constraints",
    color: "var(--color-accent)",
  },
  connected: {
    id: "connected",
    label: "connected",
    color: "var(--color-accent-2)",
  },
  links: { id: "links", label: "links", color: "var(--color-accent-light)" },
  files: { id: "files", label: "files", color: "var(--color-progress)" },
  downstream: {
    id: "downstream",
    label: "downstream",
    color: "var(--color-relates)",
  },
  dependents: {
    id: "dependents",
    label: "dependents",
    color: "var(--color-relates)",
  },
  execution: {
    id: "execution",
    label: "execution",
    color: "var(--color-done)",
  },
  project: { id: "project", label: "project", color: "var(--color-relates)" },
  blocked: { id: "blocked", label: "blocked", color: "var(--color-danger)" },
  drift: { id: "drift", label: "drift", color: "var(--color-progress)" },
  lens: { id: "lens", label: "lens", color: "var(--color-accent)" },
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

/** A 1-hop edge row for the connected drawer section. */
export interface BundleConnectedEdge extends BundleNeighbor {
  /** Edge type (depends_on / relates_to / …). */
  edgeType: string;
  /** Direction relative to the previewed task. */
  direction: "outgoing" | "incoming";
  /** Edge note, when present. */
  note: string | null;
}

interface BundlePreviewProps {
  /** Task UUID — used by the lazy bundle fetch. */
  taskId: string;
  /** Project UUID — used by the lazy bundle fetch's query key. */
  projectId: string;
  /** Schema task status. */
  status: TaskStatus;
  /** Server-derived state; undefined when the task is missing from the slim payload. */
  state?: TaskState;
  /** Project display name — drives the hierarchy line in the meta row. */
  projectName: string;
  /** Task spec (description). */
  spec: string;
  /** Task tags. */
  tags: string[];
  /** Task priority. */
  priority: string | null;
  /** Task estimate in points. */
  estimate: number | null;
  /** Resolved assignees. */
  assignees: AssigneeRef[];
  /** Acceptance criteria. */
  criteria: AcceptanceCriterion[];
  /** Implementation plan markdown. */
  plan: string | null;
  /** Direct `depends_on` prerequisites. */
  prerequisites: BundleNeighbor[];
  /** All 1-hop edges, both directions, with type and note. */
  connected: BundleConnectedEdge[];
  /** Direct `depends_on` dependents. */
  downstream: BundleNeighbor[];
  /** Pinned decisions. */
  decisions: Decision[];
  /** File paths the task touches. */
  files: string[];
  /** Task links. */
  links: TaskLinkRef[];
  /** Execution record markdown. */
  executionRecord: string | null;
  /** Click a neighbor row to navigate to that task. */
  onSelectTask?: (taskId: string) => void;
}

/** Fixed bar weight for server-only sections before the bundle is fetched. */
const SERVER_SECTION_DEFAULT_WEIGHT = 400;

/**
 * Direct prerequisites that are not finished — the client-side approximation
 * of the blocked list (cancelled deps are transparent in the effective walk,
 * so they never block).
 *
 * @param props - Bundle props.
 * @returns Unfinished direct prerequisite rows.
 */
function unfinishedPrereqs(props: BundlePreviewProps): BundleNeighbor[] {
  return props.prerequisites.filter(
    (p) => p.status !== "done" && p.status !== "cancelled",
  );
}

/**
 * Whether a client-local section has any data to show (render-if-nonempty).
 *
 * @param id - Section identifier.
 * @param props - Bundle props.
 * @returns True when the section should render.
 */
function hasLocalData(id: BundleSectionId, props: BundlePreviewProps): boolean {
  switch (id) {
    case "spec":
      return props.spec.trim().length > 0;
    case "meta":
      return true;
    case "criteria":
      return props.criteria.length > 0;
    case "plan":
      return (props.plan ?? "").trim().length > 0;
    case "prerequisites":
      return props.prerequisites.length > 0;
    case "decisions":
    case "constraints":
      return props.decisions.length > 0;
    case "connected":
      return props.connected.length > 0;
    case "links":
      return props.links.length > 0;
    case "files":
      return props.files.length > 0;
    case "downstream":
    case "dependents":
      return props.downstream.length > 0;
    case "execution":
      return (props.executionRecord ?? "").trim().length > 0;
    case "blocked":
      return unfinishedPrereqs(props).length > 0;
    default:
      return true;
  }
}

/**
 * Approximate visual weight of a section for the proportional bar. Local
 * sections weigh their prop data; server-only sections use a fixed constant
 * until the bundle is cached, then recompute from actual part lengths.
 *
 * @param id - Section identifier.
 * @param props - Bundle props.
 * @param sections - Cached bundle sections, when fetched.
 * @returns Non-negative weight (1 minimum).
 */
function sectionWeight(
  id: BundleSectionId,
  props: BundlePreviewProps,
  sections: BundlePart[] | undefined,
): number {
  if (SERVER_ONLY_SECTIONS.has(id)) {
    if (!sections) return SERVER_SECTION_DEFAULT_WEIGHT;
    return Math.max(
      sections
        .filter((s) => s.id === id)
        .reduce((sum, s) => sum + s.markdown.length, 0),
      1,
    );
  }
  const len = (s: string) => s.length;
  const refLen = (xs: BundleNeighbor[]) =>
    xs.reduce((sum, n) => sum + len(`${n.taskRef} ${n.title}`), 0);
  switch (id) {
    case "spec":
      return Math.max(len(props.spec), 1);
    case "meta":
      return Math.max(
        len(props.tags.join(" ")) + len(props.projectName) + 24,
        1,
      );
    case "criteria":
      return Math.max(
        props.criteria.reduce((sum, c) => sum + len(c.text), 0),
        1,
      );
    case "plan":
      return Math.max(len(props.plan ?? ""), 1);
    case "prerequisites":
      return Math.max(refLen(props.prerequisites), 1);
    case "connected":
      return Math.max(refLen(props.connected), 1);
    case "decisions":
    case "constraints":
      return Math.max(
        props.decisions.reduce((sum, d) => sum + len(d.text), 0),
        1,
      );
    case "links":
      return Math.max(
        props.links.reduce((sum, l) => sum + len(l.url), 0),
        1,
      );
    case "files":
      return Math.max(len(props.files.join("\n")), 1);
    case "downstream":
    case "dependents":
      return Math.max(refLen(props.downstream), 1);
    case "blocked":
      return Math.max(refLen(unfinishedPrereqs(props)), 1);
    default:
      return Math.max(len(props.executionRecord ?? ""), 1);
  }
}

/**
 * Collapsible bundle preview — shows the exact bundle the next lifecycle
 * consumer receives for the task's current stage. The drawer section list,
 * header label, and MD raw view all derive from the shared per-stage tables
 * in `bundle-tables.ts`, so the preview tracks the real
 * `lib/context/_core/*` builder output.
 *
 * @param props - Bundle data.
 * @returns Card containing the header, section bar, and section list.
 */
export function BundlePreview(props: BundlePreviewProps) {
  const { taskId, projectId, status, state, onSelectTask } = props;

  const stage = resolveStage(status, state);
  const variant = variantOf(stage);
  const kind = BUNDLE_BY_STAGE[stage];
  const bundleName = BUNDLE_LABEL_BY_STAGE[stage];
  const isBlocked = state === "blocked";

  const sectionIds = useMemo(
    () =>
      SECTIONS_BY_BUNDLE[variant].filter(
        (id) => SERVER_ONLY_SECTIONS.has(id) || hasLocalData(id, props),
      ),
    [variant, props],
  );

  const [expanded, setExpanded] = useState<Set<BundleSectionId>>(
    () =>
      new Set<BundleSectionId>(sectionIds.length > 0 ? [sectionIds[0]] : []),
  );
  const [showRaw, setShowRaw] = useState(false);

  // Reset the expanded set when the stage changes so a stale section from
  // the previous shape never lingers (render-phase derived-state reset).
  const [lastStage, setLastStage] = useState(stage);
  if (stage !== lastStage) {
    setLastStage(stage);
    setExpanded(
      new Set<BundleSectionId>(sectionIds.length > 0 ? [sectionIds[0]] : []),
    );
  }

  const qc = useQueryClient();
  const serverSectionOpen = useMemo(
    () => [...expanded].some((id) => SERVER_ONLY_SECTIONS.has(id)),
    [expanded],
  );
  const { data, isFetching: bundleFetching } = useQuery({
    queryKey: taskKeys.context(projectId, taskId, kind),
    queryFn: fetchTaskContext(qc, projectId, taskId, kind),
    enabled: showRaw || serverSectionOpen,
  });
  const sections = data?.sections;

  const rawText = useMemo(
    () => (sections ? sections.map((s) => s.markdown).join("\n\n") : ""),
    [sections],
  );

  const weights = useMemo(() => {
    const out = {} as Record<BundleSectionId, number>;
    for (const id of sectionIds) out[id] = sectionWeight(id, props, sections);
    return out;
  }, [sectionIds, props, sections]);

  /** Toggle a section's expansion state without disturbing the others. */
  const toggle = (id: BundleSectionId) => {
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
        <span className="text-[12px] font-medium text-text-primary">
          {bundleName}
        </span>
        {isBlocked && (
          <span className="inline-flex items-center rounded-md border border-danger/40 bg-danger/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-danger">
            blocked
          </span>
        )}
        <span className="ml-auto" />
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className={`cursor-pointer rounded-md border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors ${
            showRaw
              ? "border-accent/30 bg-accent/10 text-accent-light"
              : "border-border-strong text-text-muted hover:bg-surface-hover hover:text-text-secondary"
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
            {bundleFetching && !rawText
              ? "// loading bundle…"
              : rawText.trim().length > 0
                ? rawText
                : "// bundle empty — add a description and prerequisites"}
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
              sections={sections}
              bundleFetching={bundleFetching}
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
  id: BundleSectionId;
  /** Whether the section body is expanded. */
  open: boolean;
  /** True for the last section so we can suppress the divider. */
  isLast: boolean;
  /** Toggle the open state. */
  onToggle: () => void;
  /** Bundle props (data sources). */
  props: BundlePreviewProps;
  /** Cached bundle sections, when the shared fetch has resolved. */
  sections?: BundlePart[];
  /** Whether the shared bundle fetch is in flight. */
  bundleFetching: boolean;
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
function BundleSection({
  id,
  open,
  isLast,
  onToggle,
  props,
  sections,
  bundleFetching,
  onSelectTask,
}: BundleSectionProps) {
  const meta = SECTION_META[id];
  const summary = sectionSummary(id, props);

  return (
    <div className={isLast ? "" : "border-b border-border"}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-raised/40"
      >
        <span
          aria-hidden="true"
          className="h-[18px] w-1 rounded-sm"
          style={{ background: meta.color }}
        />
        <span className="w-[100px] shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {meta.label}
        </span>
        <span className="flex-1 truncate text-[12px] text-text-primary">
          {summary}
        </span>
        <span
          aria-hidden="true"
          className="inline-flex text-text-faint transition-transform duration-150"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          <IconChevronRight size={11} />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="bg-base-2 pt-1 pb-3.5 pr-3.5 pl-8">
              <SectionBody
                id={id}
                props={props}
                sections={sections}
                bundleFetching={bundleFetching}
                onSelectTask={onSelectTask}
              />
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
function sectionSummary(
  id: BundleSectionId,
  props: BundlePreviewProps,
): string {
  if (id === "spec") return "task spec";
  if (id === "meta") {
    const bits: string[] = [];
    if (props.priority) bits.push(props.priority);
    if (props.estimate) bits.push(`${props.estimate} pts`);
    if (props.tags.length > 0) bits.push(`${props.tags.length} tags`);
    return bits.length > 0 ? bits.join(" · ") : "meta";
  }
  if (id === "criteria") {
    const total = props.criteria.length;
    if (total === 0) return "no acceptance criteria";
    const checked = props.criteria.filter((c) => c.checked).length;
    return `${checked} / ${total} criteria`;
  }
  if (id === "plan") {
    return props.plan && props.plan.trim().length > 0
      ? "implementation plan"
      : "no plan yet";
  }
  if (id === "prerequisites") {
    if (props.prerequisites.length === 0) return "no upstream deps";
    const refs = props.prerequisites
      .slice(0, 2)
      .map((p) => p.taskRef)
      .join(" · ");
    return props.prerequisites.length > 2
      ? `${refs} · +${props.prerequisites.length - 2} more`
      : refs;
  }
  if (id === "connected") {
    if (props.connected.length === 0) return "no 1-hop edges";
    const refs = props.connected
      .slice(0, 3)
      .map((p) => p.taskRef)
      .join(" · ");
    return props.connected.length > 3
      ? `${refs} · +${props.connected.length - 3} more`
      : refs;
  }
  if (id === "decisions") {
    return props.decisions.length === 1
      ? "1 decision"
      : `${props.decisions.length} decisions`;
  }
  if (id === "constraints") {
    return props.decisions.length === 1
      ? "1 constraint"
      : `${props.decisions.length} constraints`;
  }
  if (id === "links") {
    return props.links.length === 1 ? "1 link" : `${props.links.length} links`;
  }
  if (id === "files") {
    if (props.files.length === 0) return "no files yet";
    return props.files.length === 1
      ? props.files[0]
      : `${props.files[0]} + ${props.files.length - 1} more`;
  }
  if (id === "downstream") {
    if (props.downstream.length === 0) return "no consumers";
    const refs = props.downstream
      .slice(0, 2)
      .map((p) => p.taskRef)
      .join(" · ");
    return props.downstream.length > 2
      ? `${refs} · +${props.downstream.length - 2} more`
      : refs;
  }
  if (id === "dependents") {
    return props.downstream.length === 1
      ? "1 remaining dependent"
      : `${props.downstream.length} remaining dependents`;
  }
  if (id === "blocked") {
    const n = unfinishedPrereqs(props).length;
    return `${n} unfinished prerequisite${n === 1 ? "" : "s"}`;
  }
  if (id === "project") return "project context";
  if (id === "built") return "upstream execution records";
  if (id === "abandoned") return "abandoned approaches";
  if (id === "drift") return "plan-vs-files drift";
  if (id === "lens") return "review lens prompts";
  return props.executionRecord && props.executionRecord.trim().length > 0
    ? "shipped record"
    : "no execution record yet";
}

interface SectionBodyProps {
  /** Section identifier. */
  id: BundleSectionId;
  /** Bundle props. */
  props: BundlePreviewProps;
  /** Cached bundle sections, when the shared fetch has resolved. */
  sections?: BundlePart[];
  /** Whether the shared bundle fetch is in flight. */
  bundleFetching: boolean;
  /** Click a neighbor row to navigate. */
  onSelectTask?: (taskId: string) => void;
}

/**
 * Section body dispatcher — chooses the right renderer for the active id.
 *
 * @param body - Body configuration.
 * @returns The matching body renderer.
 */
function SectionBody({
  id,
  props,
  sections,
  bundleFetching,
  onSelectTask,
}: SectionBodyProps) {
  if (SERVER_ONLY_SECTIONS.has(id)) {
    return (
      <ServerSectionBody
        id={id}
        sections={sections}
        fetching={bundleFetching}
      />
    );
  }
  if (id === "spec")
    return (
      <MarkdownBody
        text={props.spec}
        emptyHint="No spec yet — add a description above."
      />
    );
  if (id === "meta") return <MetaBody props={props} />;
  if (id === "criteria") return <CriteriaBody criteria={props.criteria} />;
  if (id === "plan")
    return (
      <MarkdownBody
        text={props.plan ?? ""}
        emptyHint="No implementation plan yet."
      />
    );
  if (id === "prerequisites") {
    return (
      <NeighborList
        items={props.prerequisites}
        emptyHint="No upstream dependencies."
        onSelectTask={onSelectTask}
      />
    );
  }
  if (id === "connected") {
    return (
      <ConnectedList items={props.connected} onSelectTask={onSelectTask} />
    );
  }
  if (id === "decisions" || id === "constraints") {
    return <DecisionsBody decisions={props.decisions} />;
  }
  if (id === "files") return <FilesBody files={props.files} />;
  if (id === "links") return <LinksBody links={props.links} />;
  if (id === "downstream" || id === "dependents") {
    return (
      <NeighborList
        items={props.downstream}
        emptyHint="No downstream consumers."
        onSelectTask={onSelectTask}
      />
    );
  }
  if (id === "blocked") {
    return <BlockedBody props={props} onSelectTask={onSelectTask} />;
  }
  return (
    <MarkdownBody
      text={props.executionRecord ?? ""}
      emptyHint="No execution record yet — populated when the task ships."
    />
  );
}

interface ServerSectionBodyProps {
  /** Section identifier. */
  id: BundleSectionId;
  /** Cached bundle sections, when fetched. */
  sections?: BundlePart[];
  /** Whether the shared bundle fetch is in flight. */
  fetching: boolean;
}

/**
 * Body for server-only sections: renders the matching bundle parts once the
 * shared fetch resolves; shows a loading hint while it is in flight.
 *
 * @param props - Section id, cached sections, and fetch state.
 * @returns Markdown body, loading hint, or empty hint.
 */
function ServerSectionBody({ id, sections, fetching }: ServerSectionBodyProps) {
  if (!sections) {
    return (
      <p className="font-mono text-[11.5px] italic text-text-muted">
        {fetching ? "// loading bundle…" : "// expand fetches the bundle…"}
      </p>
    );
  }
  const matched = sections.filter((s) => s.id === id);
  if (matched.length === 0) {
    return (
      <p className="font-mono text-[11.5px] italic text-text-muted">
        Not present in this bundle.
      </p>
    );
  }
  return (
    <Markdown className="text-[12.5px] leading-relaxed text-text-secondary">
      {matched.map((s) => s.markdown).join("\n\n")}
    </Markdown>
  );
}

interface MetaBodyProps {
  /** Bundle props. */
  props: BundlePreviewProps;
}

/**
 * Compact meta row: priority / estimate / assignees, tag chips, and the
 * project hierarchy line — one drawer row covering three adjacent bundle
 * headings.
 *
 * @param props - Bundle props.
 * @returns Meta body element.
 */
function MetaBody({ props }: MetaBodyProps) {
  const bits: string[] = [];
  if (props.priority) bits.push(`priority ${props.priority}`);
  if (props.estimate) bits.push(`${props.estimate} pts`);
  if (props.assignees.length > 0) {
    bits.push(props.assignees.map((a) => a.name).join(", "));
  }
  return (
    <div className="space-y-1.5">
      {bits.length > 0 && (
        <p className="font-mono text-[11.5px] text-text-secondary">
          {bits.join(" · ")}
        </p>
      )}
      {props.tags.length > 0 && (
        <p className="flex flex-wrap gap-1.5">
          {props.tags.map((t) => (
            <span
              key={t}
              className="rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-text-secondary"
            >
              {t}
            </span>
          ))}
        </p>
      )}
      <p className="font-mono text-[10.5px] text-text-faint">
        project: {props.projectName}
      </p>
    </div>
  );
}

interface ConnectedListProps {
  /** Connected edge rows. */
  items: BundleConnectedEdge[];
  /** Click a row to navigate. */
  onSelectTask?: (taskId: string) => void;
}

/**
 * All 1-hop edges with direction glyphs: `edgeType →/←` + ref + title.
 *
 * @param props - Connected edges and navigation handler.
 * @returns Stack of connected rows or empty hint.
 */
function ConnectedList({ items, onSelectTask }: ConnectedListProps) {
  if (items.length === 0) {
    return (
      <p className="font-mono text-[11.5px] italic text-text-muted">
        No 1-hop edges.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {items.map((n) => (
        <li key={`${n.edgeType}-${n.direction}-${n.id}`}>
          <button
            type="button"
            onClick={() => onSelectTask?.(n.id)}
            className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-hover"
          >
            <span className="font-mono text-[10px] text-text-faint">
              {n.edgeType} {n.direction === "outgoing" ? "→" : "←"}
            </span>
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

interface LinksBodyProps {
  /** Task links. */
  links: TaskLinkRef[];
}

/**
 * Task links list: kind chip + label or URL, mono.
 *
 * @param props - Task links.
 * @returns Stack of link rows or empty hint.
 */
function LinksBody({ links }: LinksBodyProps) {
  if (links.length === 0) {
    return (
      <p className="font-mono text-[11.5px] italic text-text-muted">
        No links.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {links.map((l) => (
        <li
          key={l.id}
          className="flex items-center gap-2 font-mono text-[11.5px] text-text-secondary"
        >
          <span className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text-muted">
            {l.kind}
          </span>
          <span className="truncate" title={l.url}>
            {l.label ?? l.url}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface BlockedBodyProps {
  /** Bundle props. */
  props: BundlePreviewProps;
  /** Click a row to navigate. */
  onSelectTask?: (taskId: string) => void;
}

/**
 * Blocked callout: the lifecycle warning plus the unfinished direct
 * prerequisites blocking this task.
 *
 * @param props - Bundle props and navigation handler.
 * @returns Blocked body element.
 */
function BlockedBody({ props, onSelectTask }: BlockedBodyProps) {
  return (
    <div className="space-y-2">
      <p className="text-[12px] leading-snug text-text-secondary">
        Prerequisites are not done — building now means building against
        unshipped interfaces. Read-ahead context only.
      </p>
      <NeighborList
        items={unfinishedPrereqs(props)}
        emptyHint="No unfinished prerequisites."
        onSelectTask={onSelectTask}
      />
    </div>
  );
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
    return (
      <p className="font-mono text-[11.5px] italic text-text-muted">
        {emptyHint}
      </p>
    );
  }
  return (
    <Markdown className="text-[12.5px] leading-relaxed text-text-secondary">
      {text}
    </Markdown>
  );
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
    return (
      <p className="font-mono text-[11.5px] italic text-text-muted">
        No acceptance criteria yet.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {criteria.map((c) => (
        <li key={c.id} className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className="mt-[3px] inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border"
            style={{
              background: c.checked
                ? "var(--color-accent-grad)"
                : "transparent",
              borderColor: c.checked
                ? "transparent"
                : "var(--color-border-strong)",
            }}
          >
            {c.checked && (
              <svg width="8" height="8" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M3 8.5L6.5 12 13 5"
                  stroke="var(--color-base)"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
          <span
            className={`text-[12.5px] leading-snug ${c.checked ? "text-text-muted line-through decoration-text-faint" : "text-text-secondary"}`}
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
    return (
      <p className="font-mono text-[11.5px] italic text-text-muted">
        {emptyHint}
      </p>
    );
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
    return (
      <p className="font-mono text-[11.5px] italic text-text-muted">
        No pinned decisions.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {decisions.map((d) => (
        <li key={d.id} className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] leading-snug text-text-secondary">
              {d.text}
            </p>
            <span className="font-mono text-[10px] text-text-faint">
              {d.date}
            </span>
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
    return (
      <p className="font-mono text-[11.5px] italic text-text-muted">
        No files touched yet.
      </p>
    );
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
