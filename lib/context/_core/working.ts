import "server-only";

import type { AcceptanceCriterion } from "@/lib/types";
import { getAncestors } from "@/lib/data/traversal";
import { getTaskEdgesDetailed } from "@/lib/data/edge";
import { getProjectIdentifier } from "@/lib/data/project";
import {
  fetchSiblingTasks,
  fetchAssigneesUnchecked,
  fetchLinksUnchecked,
} from "@/lib/data/task";
import type { AssigneeRef, TaskLinkRef } from "@/lib/data/views";
import { asIdentifier, composeTaskRef } from "@/lib/graph/identifier";
import { section, formatCriteria } from "@/lib/context/format";
import type { AuthContext } from "@/lib/auth/context";
import { assertTaskAccess } from "@/lib/auth/authorization";

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
  siblings: { id: string; taskRef: string; title: string; status: string }[];
  assignees: AssigneeRef[];
  links: TaskLinkRef[];
};

/**
 * Build full working context for a task. 1-hop traversal.
 *
 * Sections ordered by U-shaped attention: header + description + criteria at
 * start, edges + siblings in middle. No token budget — all content included
 * as-is. Used by MCP for `mymir_context depth='working'`.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Working context with task data, ancestors, edges, and siblings.
 */
export async function buildWorkingContext(
  ctx: AuthContext,
  taskId: string,
): Promise<WorkingContext> {
  const task = await assertTaskAccess(taskId, ctx);
  const projectId = task.projectId;

  const [identifier, ancestors, detailedEdges, siblings, assignees, links] =
    await Promise.all([
      getProjectIdentifier(projectId),
      getAncestors(taskId),
      getTaskEdgesDetailed(ctx, taskId),
      fetchSiblingTasks(projectId, taskId),
      fetchAssigneesUnchecked(taskId),
      fetchLinksUnchecked(taskId),
    ]);

  if (!identifier) {
    console.error("Task has no joinable project", {
      taskId: task.id,
      projectId: task.projectId,
    });
  }
  const taskRef = identifier
    ? composeTaskRef(asIdentifier(identifier), task.sequenceNumber)
    : "";

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
    taskRef,
    ancestors,
    edges,
    siblings,
    assignees,
    links,
  };
}

/**
 * Format working context as structured markdown for AI consumption.
 * @param ctx - The raw working context object.
 * @returns Human-readable markdown string.
 */
export async function formatWorkingContext(
  ctx: WorkingContext,
): Promise<string> {
  const node = ctx.node;
  const title = (node.title as string) ?? "Untitled";
  const status = (node.status as string) ?? "draft";
  const description = (node.description as string) ?? "";

  const parts: string[] = [
    `# ${ctx.taskRef ? `\`${ctx.taskRef}\` ` : ""}"${title}" (${status})`,
  ];

  if (description) parts.push(`\n## Description\n${description}`);

  const meta = formatMetaSection(node, ctx.assignees, ctx.links);
  if (meta) parts.push(meta);

  const tags = formatTagsSection(node);
  if (tags) parts.push(tags);

  const criteria = formatCriteriaSection(node);
  if (criteria) parts.push(criteria);

  const hierarchy = formatHierarchySection(ctx, title);
  if (hierarchy) parts.push(hierarchy);

  const decisions = formatDecisionsSection(node);
  if (decisions) parts.push(decisions);

  const edges = formatEdgesSection(ctx.edges);
  if (edges) parts.push(edges);

  const siblings = formatSiblingsSection(ctx.siblings);
  if (siblings) parts.push(siblings);

  const links = formatLinksSection(ctx.links);
  if (links) parts.push(links);

  return parts.join("\n");
}

/**
 * Format the meta section: priority, estimate, assignees. Each line is
 * suppressed when the corresponding field is unset, so a task with no
 * meta drops the section entirely.
 *
 * @param node - Raw task row.
 * @param assignees - Resolved assignee projection.
 * @returns Formatted meta section or empty string.
 */
function formatMetaSection(
  node: Record<string, unknown>,
  assignees: AssigneeRef[],
  links: TaskLinkRef[],
): string {
  const lines: string[] = [];
  const priority = (node.priority as string | null) ?? null;
  const estimate = (node.estimate as number | null) ?? null;
  if (priority) lines.push(`- Priority: \`${priority}\``);
  if (estimate) lines.push(`- Estimate: ${estimate} pts`);
  if (assignees.length > 0) {
    const names = assignees.map((a) => a.name).join(", ");
    lines.push(`- Assignees: ${names}`);
  }
  const prLink = links.find((l) => l.kind === "pull_request");
  if (prLink) lines.push(`- PR: ${prLink.url}`);
  if (lines.length === 0) return "";
  return "\n## Meta\n" + lines.join("\n");
}

/**
 * Format the Links section: one line per task_link with a derived host.
 *
 * @param links - Task links projection.
 * @returns Formatted Links section or empty string.
 */
function formatLinksSection(links: TaskLinkRef[]): string {
  if (links.length === 0) return "";
  const lines = ["\n## Links"];
  for (const l of links) {
    let host = "";
    try {
      host = new URL(l.url).host;
    } catch {
      host = l.url;
    }
    const display = l.label ?? host;
    lines.push(`- [${l.kind}] ${display} — ${l.url}`);
  }
  return lines.join("\n");
}

/**
 * Format tags section.
 * @param node - Raw node data.
 * @returns Formatted tags section or empty string.
 */
function formatTagsSection(node: Record<string, unknown>): string {
  const tags = (node.tags as string[]) ?? [];
  if (tags.length === 0) return "";
  return `\n## Tags\n${tags.map((t) => `\`${t}\``).join(", ")}`;
}

/**
 * Format acceptance criteria section.
 * @param node - Raw node data.
 * @returns Formatted criteria section or empty string.
 */
function formatCriteriaSection(node: Record<string, unknown>): string {
  const criteria = (node.acceptanceCriteria as AcceptanceCriterion[]) ?? [];
  if (criteria.length === 0) return "";
  return section("Acceptance Criteria") + "\n" + formatCriteria(criteria);
}

/**
 * Format decisions section.
 * @param node - Raw node data.
 * @returns Formatted decisions section or empty string.
 */
function formatDecisionsSection(node: Record<string, unknown>): string {
  const decisions =
    (node.decisions as { text: string; source: string; date: string }[]) ?? [];
  if (decisions.length === 0) return "";
  const lines = ["\n## Decisions"];
  for (const d of decisions) {
    lines.push(`- [${d.source}] ${d.text} (${d.date})`);
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
  return `\n## Hierarchy\n${path} > task: "${title}"`;
}

/**
 * Format connected edges section.
 * @param edges - Array of edge data with notes.
 * @returns Formatted edges section or empty string.
 */
function formatEdgesSection(edges: WorkingContext["edges"]): string {
  if (edges.length === 0) return "";
  const lines = ["\n## Connected Tasks"];
  for (const e of edges) {
    const arrow = e.direction === "outgoing" ? "→" : "←";
    let line = `- ${e.edgeType} ${arrow} \`${e.taskRef}\` "${e.title}" (${e.status})`;
    if (e.note) line += ` — ${e.note}`;
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Format siblings section.
 * @param siblings - Array of sibling task summaries.
 * @returns Formatted siblings section or empty string.
 */
function formatSiblingsSection(siblings: WorkingContext["siblings"]): string {
  if (siblings.length === 0) return "";
  const lines = ["\n## Siblings"];
  for (const s of siblings) {
    lines.push(`- \`${s.taskRef}\` "${s.title}" (${s.status})`);
  }
  return lines.join("\n");
}
