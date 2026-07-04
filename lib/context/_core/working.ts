import "server-only";

import type { AcceptanceCriterion } from "@/lib/types";
import type { AssigneeRef, TaskLinkRef } from "@/lib/data/views";
import {
  capLines,
  formatCriteria,
  formatLinkLine,
  untrustedContentNotice,
} from "@/lib/context/format";
import { joinParts, type BundlePart } from "@/lib/context/parts";
import type { AuthContext } from "@/lib/auth/context";
import {
  resolveWorkingData,
  type WorkingContextData,
} from "@/lib/context/_core/bundle";

/** Full working context for AI assistant (1-hop). */
type WorkingContext = {
  node: Record<string, unknown>;
  taskRef: string;
  ancestors: { id: string; type: "project"; title: string }[];
  edges: {
    id: string;
    taskRef: string;
    edgeType: string;
    direction: "outgoing" | "incoming";
    title: string;
    status: string;
    note: string;
  }[];
  assignees: AssigneeRef[];
  links: TaskLinkRef[];
};

/**
 * Assemble the working context from pre-resolved working data. 1-hop edges plus
 * the ancestor chain. Pure: reads only its argument, issues no queries.
 *
 * @param data Resolved working data (task row, detailed edges, ancestors).
 * @returns Working context with task data, ancestors, and edges.
 */
export function buildWorkingContextFrom(
  data: WorkingContextData,
): WorkingContext {
  const { task, detailedEdges, ancestors } = data;

  const edges = detailedEdges.map((e) => ({
    id: e.connectedTask.id,
    taskRef: e.connectedTask.taskRef,
    edgeType: e.edgeType as string,
    direction: e.direction,
    title: e.connectedTask.title,
    status: e.connectedTask.status,
    note: e.note,
  }));

  return {
    node: task as unknown as Record<string, unknown>,
    taskRef: task.taskRef,
    ancestors,
    edges,
    assignees: task.assignees,
    links: task.links,
  };
}

/**
 * Build full working context for a task. 1-hop traversal.
 *
 * Resolves only the working data this depth renders (no dependency closure or
 * project header), then delegates to the pure {@link buildWorkingContextFrom}
 * assembler. Used by MCP for `piyaz_get lens='working'`.
 *
 * @param ctx Resolved auth context.
 * @param taskId UUID of the task.
 * @returns Working context with task data, ancestors, and edges.
 */
export async function buildWorkingContext(
  ctx: AuthContext,
  taskId: string,
): Promise<WorkingContext> {
  const data = await resolveWorkingData(ctx.userId, taskId);
  return buildWorkingContextFrom(data);
}

/**
 * Assemble the working context as structured bundle parts.
 *
 * Meta, Tags, and Hierarchy are adjacent and share the `meta` part id — the
 * preview drawer renders them as one compact row (declared N:1 grouping).
 *
 * @param ctx - The raw working context object.
 * @returns Ordered bundle parts; join with {@link joinParts} for markdown.
 */
export function formatWorkingContextParts(ctx: WorkingContext): BundlePart[] {
  const node = ctx.node;
  const title = (node.title as string) ?? "Untitled";
  const status = (node.status as string) ?? "draft";
  const description = (node.description as string) ?? "";

  const parts: BundlePart[] = [
    {
      id: "notice",
      heading: null,
      markdown: untrustedContentNotice("working"),
    },
    {
      id: "header",
      heading: null,
      markdown: `# ${ctx.taskRef ? `\`${ctx.taskRef}\` ` : ""}"${title}" (${status})`,
    },
  ];

  if (description) {
    parts.push({
      id: "spec",
      heading: "Description",
      markdown: `## Description\n${description}`,
    });
  }

  const meta = formatMetaSection(node, ctx.assignees, ctx.links);
  if (meta) parts.push({ id: "meta", heading: "Meta", markdown: meta });

  const tags = formatTagsSection(node);
  if (tags) parts.push({ id: "meta", heading: "Tags", markdown: tags });

  const hierarchy = formatHierarchySection(ctx, title);
  if (hierarchy) {
    parts.push({ id: "meta", heading: "Hierarchy", markdown: hierarchy });
  }

  const criteria = formatCriteriaSection(node);
  if (criteria) {
    parts.push({
      id: "criteria",
      heading: "Acceptance Criteria",
      markdown: criteria,
    });
  }

  const decisions = formatDecisionsSection(node);
  if (decisions) {
    parts.push({ id: "decisions", heading: "Decisions", markdown: decisions });
  }

  const edges = formatEdgesSection(ctx.edges, ctx.taskRef);
  if (edges) {
    parts.push({
      id: "connected",
      heading: "Connected Tasks",
      markdown: edges,
    });
  }

  const links = formatLinksSection(ctx.links);
  if (links) parts.push({ id: "links", heading: "Links", markdown: links });

  return parts;
}

/**
 * Format working context as structured markdown for AI consumption.
 * @param ctx - The raw working context object.
 * @returns Human-readable markdown string.
 */
export async function formatWorkingContext(
  ctx: WorkingContext,
): Promise<string> {
  return joinParts(formatWorkingContextParts(ctx));
}

/**
 * Format the meta section: category, priority, estimate, assignees. Each
 * line is suppressed when the corresponding field is unset, so a task with
 * no meta drops the section entirely.
 *
 * @param node - Raw task row.
 * @param assignees - Resolved assignee projection.
 * @param links - Task links projection; the pull-request link drives the PR line.
 * @returns Formatted meta section or empty string.
 */
function formatMetaSection(
  node: Record<string, unknown>,
  assignees: AssigneeRef[],
  links: TaskLinkRef[],
): string {
  const lines: string[] = [];
  const category = (node.category as string | null) ?? null;
  const priority = (node.priority as string | null) ?? null;
  const estimate = (node.estimate as number | null) ?? null;
  if (category) lines.push(`- Category: \`${category}\``);
  if (priority) lines.push(`- Priority: \`${priority}\``);
  if (estimate) lines.push(`- Estimate: ${estimate} pts`);
  if (assignees.length > 0) {
    const names = assignees.map((a) => a.name).join(", ");
    lines.push(`- Assignees: ${names}`);
  }
  const prLink = links.find((l) => l.kind === "pull_request");
  if (prLink) lines.push(`- PR: ${prLink.url}`);
  if (lines.length === 0) return "";
  return "## Meta\n" + lines.join("\n");
}

/**
 * Format the Links section: one line per task_link with a derived host.
 *
 * @param links - Task links projection.
 * @returns Formatted Links section or empty string.
 */
function formatLinksSection(links: TaskLinkRef[]): string {
  if (links.length === 0) return "";
  return ["## Links", ...links.map(formatLinkLine)].join("\n");
}

/**
 * Format tags section.
 * @param node - Raw node data.
 * @returns Formatted tags section or empty string.
 */
function formatTagsSection(node: Record<string, unknown>): string {
  const tags = (node.tags as string[]) ?? [];
  if (tags.length === 0) return "";
  return `## Tags\n${tags.map((t) => `\`${t}\``).join(", ")}`;
}

/**
 * Format acceptance criteria section.
 * @param node - Raw node data.
 * @returns Formatted criteria section or empty string.
 */
function formatCriteriaSection(node: Record<string, unknown>): string {
  const criteria = (node.acceptanceCriteria as AcceptanceCriterion[]) ?? [];
  if (criteria.length === 0) return "";
  return "## Acceptance Criteria\n\n" + formatCriteria(criteria);
}

/**
 * Format decisions section. Each line carries the item's backticked id —
 * the working lens is the edit-address read, so decisions must be
 * addressable by `piyaz_edit` by-id ops just like acceptance criteria.
 * @param node - Raw node data.
 * @returns Formatted decisions section or empty string.
 */
function formatDecisionsSection(node: Record<string, unknown>): string {
  const decisions =
    (node.decisions as {
      id: string;
      text: string;
      source: string;
      date: string;
    }[]) ?? [];
  if (decisions.length === 0) return "";
  const lines = ["## Decisions"];
  for (const d of decisions) {
    lines.push(`- [${d.source}] \`${d.id}\` ${d.text} (${d.date})`);
  }
  return lines.join("\n");
}

/**
 * Format hierarchy section from ancestors.
 * @param ctx - Working context.
 * @param title - Title of the current task.
 * @returns Formatted hierarchy section or empty string.
 */
function formatHierarchySection(ctx: WorkingContext, title: string): string {
  if (ctx.ancestors.length === 0) return "";
  const path = [...ctx.ancestors]
    .reverse()
    .map((a) => `${a.type}: "${a.title}"`)
    .join(" > ");
  return `## Hierarchy\n${path} > task: "${title}"`;
}

/**
 * Format connected edges section, width-capped for hub tasks.
 * @param edges - Array of edge data with notes.
 * @param taskRef - Origin task ref for the truncation guidance.
 * @returns Formatted edges section or empty string.
 */
function formatEdgesSection(
  edges: WorkingContext["edges"],
  taskRef: string | null,
): string {
  if (edges.length === 0) return "";
  const edgeLines: string[] = [];
  for (const e of edges) {
    const arrow = e.direction === "outgoing" ? "→" : "←";
    let line = `- ${e.edgeType} ${arrow} \`${e.taskRef}\` "${e.title}" (${e.status})`;
    if (e.note) line += ` — ${e.note}`;
    edgeLines.push(line);
  }
  return [
    "## Connected Tasks",
    ...capLines(
      edgeLines,
      `run piyaz_map view='neighbors'${taskRef ? ` task='${taskRef}'` : ""} for the full list.`,
    ),
  ].join("\n");
}
