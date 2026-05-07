import "server-only";

import type { AcceptanceCriterion } from "@/lib/types";
import { getAncestors } from "@/lib/data/traversal";
import { getTaskEdgesDetailed } from "@/lib/data/edge";
import { getProjectIdentifier } from "@/lib/data/project";
import { fetchSiblingTasks } from "@/lib/data/task";
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

  const [identifier, ancestors, detailedEdges, siblings] = await Promise.all([
    getProjectIdentifier(projectId),
    getAncestors(taskId),
    getTaskEdgesDetailed(ctx, taskId),
    fetchSiblingTasks(projectId, taskId),
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

  return parts.join("\n");
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
