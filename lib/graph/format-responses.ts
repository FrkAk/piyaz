/**
 * Formatters that convert tool handler responses to token-efficient text.
 * Used by shared handlers so both web AI SDK and MCP get identical output.
 */

import type { SearchResult, TaskSlim } from "@/lib/data/task";
import type { DetailedEdge } from "@/lib/data/edge";
import type {
  ReadyTask,
  PlannableTask,
  BlockedTask,
  CriticalPathTask,
  DownstreamNode,
} from "@/lib/data/traversal";
import type { ProjectOverview } from "@/lib/context/_core/overview";
import type { SummaryContext } from "@/lib/context/_core/summary";
import type { ProjectMeta } from "@/lib/data/views";

const STATUS_ORDER = ["in_progress", "planned", "draft", "done", "cancelled"] as const;

/**
 * Format a task as a compact single line.
 * @param t - Task with id, title, status, and optional tags/category/priority/estimate/assignees.
 * @returns Formatted line string.
 */
function taskLine(t: {
  id: string;
  taskRef: string;
  title: string;
  status: string;
  tags?: string[];
  category?: string | null;
  priority?: string | null;
  estimate?: number | null;
  assigneeCount?: number;
}): string {
  let line = `- \`${t.taskRef}\` "${t.title}" [${t.status}] \`${t.id}\``;
  if (t.category) line += ` | ${t.category}`;
  if (t.priority) line += ` | ${t.priority}`;
  if (t.estimate) line += ` | ${t.estimate}pts`;
  if (t.assigneeCount && t.assigneeCount > 0)
    line += ` | ${t.assigneeCount} assigned`;
  if (t.tags && t.tags.length > 0) line += `  tags: ${t.tags.join(", ")}`;
  return line;
}

/**
 * Render tasks grouped by status as markdown sections.
 * @param tasks - Array of tasks to group.
 * @param renderLine - Function to render each task.
 * @returns Formatted sections joined by newlines.
 */
function renderGrouped<T extends { status: string }>(tasks: T[], renderLine: (t: T) => string): string {
  const groups = new Map<string, T[]>();
  for (const t of tasks) {
    const list = groups.get(t.status) ?? [];
    list.push(t);
    groups.set(t.status, list);
  }
  const parts: string[] = [];
  for (const status of STATUS_ORDER) {
    const group = groups.get(status);
    if (!group || group.length === 0) continue;
    parts.push(`\n## ${status} (${group.length})`);
    for (const t of group) parts.push(renderLine(t));
  }
  return parts.join("\n");
}

/**
 * Format summary context as compact markdown.
 * @param ctx - SummaryContext from buildSummaryContext.
 * @returns Formatted text with title, stats, and edges.
 */
export function formatSummary(ctx: SummaryContext): string {
  const header = ctx.node.taskRef
    ? `# \`${ctx.node.taskRef}\` "${ctx.node.title}" [${ctx.node.status}]`
    : `# "${ctx.node.title}" [${ctx.node.status}]`;
  const parts: string[] = [header];
  if (ctx.parent) parts.push(`Project: "${ctx.parent.title}"`);
  if (ctx.node.description) parts.push(`\n${ctx.node.description}`);

  const stats: string[] = [];
  if (ctx.edgeCount.depends_on > 0) stats.push(`${ctx.edgeCount.depends_on} depends_on`);
  if (ctx.edgeCount.relates_to > 0) stats.push(`${ctx.edgeCount.relates_to} relates_to`);
  stats.push(`${ctx.acceptanceCriteriaCount} criteria`, `${ctx.decisionsCount} decisions`);
  if (ctx.node.priority) stats.push(`priority: ${ctx.node.priority}`);
  if (ctx.node.estimate) stats.push(`${ctx.node.estimate}pts`);
  if (ctx.assigneeCount > 0) stats.push(`${ctx.assigneeCount} assigned`);
  if (ctx.hasImplementationPlan) stats.push("has plan");
  parts.push(`\n${stats.join(" | ")}`);

  if (ctx.edges.length > 0) {
    parts.push("\n## Edges");
    for (const e of ctx.edges) {
      const arrow = e.direction === "outgoing" ? "\u2192" : "\u2190";
      let line = `- ${e.edgeType} ${arrow} \`${e.connectedTaskRef}\` "${e.connectedTaskTitle}" [${e.connectedTaskStatus}] \`${e.connectedTaskId}\``;
      if (e.note) line += ` \u2014 ${e.note}`;
      parts.push(line);
    }
  }
  return parts.join("\n");
}

/**
 * Format search results as compact text with optional state hint.
 * @param results - Search result array.
 * @param hint - Optional state hint for single-result searches.
 * @returns Formatted text with one result per line.
 */
export function formatSearchResults(results: SearchResult[], hint?: string): string {
  const parts: string[] =
    results.length === 0
      ? ["No results found."]
      : [`Found ${results.length} result${results.length > 1 ? "s" : ""}:`];
  for (const r of results) {
    let line = `- \`${r.taskRef}\` "${r.title}" [${r.status}|${r.state}] \`${r.id}\``;
    if (r.category) line += ` | ${r.category}`;
    if (r.priority) line += ` | ${r.priority}`;
    if (r.estimate) line += ` | ${r.estimate}pts`;
    if (r.assigneeCount && r.assigneeCount > 0)
      line += ` | ${r.assigneeCount} assigned`;
    if (r.tags.length > 0) line += `  tags: ${r.tags.join(", ")}`;
    parts.push(line);
  }
  if (hint) parts.push(`\n> ${hint}`);
  return parts.join("\n");
}

/**
 * Format slim task list grouped by status.
 * @param tasks - Slim task array from getProjectTasksSlim.
 * @returns Formatted text grouped by status.
 */
export function formatTaskList(tasks: TaskSlim[]): string {
  if (tasks.length === 0) return "No tasks.";
  const done = tasks.filter((t) => t.status === "done").length;
  const cancelled = tasks.filter((t) => t.status === "cancelled").length;
  const inProg = tasks.filter((t) => t.status === "in_progress").length;
  const other = tasks.length - done - cancelled - inProg;
  const header = `${tasks.length} tasks (${done} done, ${cancelled} cancelled, ${inProg} in_progress, ${other} other):`;
  return header + renderGrouped(tasks, taskLine);
}

/**
 * Format detailed edges list with directions and notes.
 * @param edges - DetailedEdge array from getTaskEdgesDetailed.
 * @returns Formatted text with one edge per line.
 */
export function formatDetailedEdges(edges: DetailedEdge[]): string {
  if (edges.length === 0) return "No edges.";
  const parts: string[] = [`${edges.length} edge${edges.length > 1 ? "s" : ""}:`];
  for (const e of edges) {
    const arrow = e.direction === "outgoing" ? "\u2192" : "\u2190";
    let line = `- ${e.edgeType} ${arrow} \`${e.connectedTask.taskRef}\` "${e.connectedTask.title}" [${e.connectedTask.status}] \`${e.edgeId}\``;
    if (e.note) line += ` \u2014 ${e.note}`;
    parts.push(line);
  }
  return parts.join("\n");
}

/**
 * Format slim project metadata: header, progress, categories, tag vocab
 * (with counts), description. No task list, no edges. Lightweight
 * counterpart to {@link formatOverview} for agent orientation.
 *
 * @param meta - ProjectMeta from getProjectMeta.
 * @returns Formatted markdown.
 */
export function formatProjectMeta(meta: ProjectMeta): string {
  const denominator = meta.taskStats.total - meta.taskStats.cancelled;
  const parts: string[] = [
    `# \`${meta.identifier}\` "${meta.title}" [${meta.status}]`,
    `Progress: ${meta.taskStats.done}/${denominator} done (${meta.progress}%) | ${meta.taskStats.inProgress} in_progress | ${meta.taskStats.cancelled} cancelled`,
  ];
  if (meta.categories.length > 0)
    parts.push(`Categories: ${meta.categories.join(", ")}`);
  if (meta.tagVocabulary.length > 0) {
    const tagLine = meta.tagVocabulary
      .map((t) => `${t.tag} (${t.count})`)
      .join(", ");
    parts.push(`Tags: ${tagLine}`);
  }
  if (meta.description) parts.push(`\n${meta.description}`);
  return parts.join("\n");
}

/**
 * Format project overview with progress, tasks by status, and edges.
 * @param overview - ProjectOverview from buildProjectOverview.
 * @returns Formatted markdown overview.
 */
export function formatOverview(overview: ProjectOverview): string {
  const denominator = overview.totalTasks - overview.cancelledTasks;
  const parts: string[] = [
    `# \`${overview.identifier}\` "${overview.title}" [${overview.status}]`,
    `Progress: ${overview.doneTasks}/${denominator} done (${overview.progress}%) | ${overview.inProgressTasks} in_progress | ${overview.cancelledTasks} cancelled`,
  ];
  if (overview.categories.length > 0) parts.push(`Categories: ${overview.categories.join(", ")}`);
  if (overview.tagVocabulary.length > 0) parts.push(`Tags: ${overview.tagVocabulary.join(", ")}`);
  if (overview.description) parts.push(`\n${overview.description}`);

  if (overview.tasks.length > 0) {
    parts.push(renderGrouped(overview.tasks, (t) => {
      let line = `- \`${t.taskRef}\` "${t.title}" \`${t.id}\``;
      if (t.category) line += ` | ${t.category}`;
      if (t.priority) line += ` | ${t.priority}`;
      if (t.estimate) line += ` | ${t.estimate}pts`;
      if (t.assigneeCount && t.assigneeCount > 0)
        line += ` | ${t.assigneeCount} assigned`;
      return line;
    }));
  }

  if (overview.edges.length > 0) {
    parts.push(`\n## Dependencies (${overview.edges.length})`);
    for (const e of overview.edges) {
      let line = `- \`${e.sourceTaskRef}\` "${e.sourceTitle}" ${e.edgeType} \u2192 \`${e.targetTaskRef}\` "${e.targetTitle}"`;
      if (e.note) line += ` \u2014 ${e.note}`;
      parts.push(line);
    }
  }
  return parts.join("\n");
}

/**
 * Format ready tasks list.
 * @param tasks - Ready task array from getReadyTasks.
 * @returns Formatted text, includes hint when empty.
 */
export function formatReadyTasks(tasks: ReadyTask[]): string {
  if (tasks.length === 0)
    return "No ready tasks.\n\n> Run type='plannable' to find tasks to plan, or type='blocked' for blockers.";
  const parts = [`${tasks.length} ready task${tasks.length > 1 ? "s" : ""}:`];
  for (const t of tasks) parts.push(taskLine(t));
  return parts.join("\n");
}

/**
 * Format blocked tasks with blocker details.
 * @param tasks - BlockedTask array from getBlockedTasks.
 * @returns Formatted text with blockers indented.
 */
export function formatBlockedTasks(tasks: BlockedTask[]): string {
  if (tasks.length === 0) return "No blocked tasks.";
  const parts: string[] = [`${tasks.length} blocked task${tasks.length > 1 ? "s" : ""}:`];
  for (const t of tasks) {
    parts.push(`- \`${t.taskRef}\` "${t.title}" [${t.status}] \`${t.id}\``);
    for (const b of t.blockedBy)
      parts.push(`  blocked by: \`${b.taskRef}\` "${b.title}" [${b.status}] \`${b.id}\``);
  }
  return parts.join("\n");
}

/**
 * Format downstream task chain with depth levels.
 * @param nodes - DownstreamNode array from getDownstream.
 * @returns Formatted text with ids and depths.
 */
export function formatDownstream(nodes: DownstreamNode[]): string {
  if (nodes.length === 0) return "No downstream tasks.";
  const parts = [`${nodes.length} downstream task${nodes.length > 1 ? "s" : ""}:`];
  for (const n of nodes) parts.push(`- depth ${n.depth}: \`${n.taskRef}\` "${n.title}" \`${n.id}\``);
  return parts.join("\n");
}

/**
 * Format critical path as numbered chain.
 * @param tasks - CriticalPathTask array forming the longest chain.
 * @returns Formatted numbered list.
 */
export function formatCriticalPath(tasks: CriticalPathTask[]): string {
  if (tasks.length === 0) return "No critical path found (no dependency chains).";
  const parts = [`Critical path (${tasks.length} task${tasks.length > 1 ? "s" : ""}):`,];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    parts.push(`${i + 1}. \`${t.taskRef}\` "${t.title}" [${t.status}] \`${t.id}\``);
  }
  return parts.join("\n");
}

/**
 * Format plannable tasks list.
 * @param tasks - PlannableTask array from getPlannableTasks.
 * @returns Formatted text, includes hint when empty.
 */
export function formatPlannableTasks(tasks: PlannableTask[]): string {
  if (tasks.length === 0)
    return "No plannable tasks.\n\n> Drafts must have description, acceptance criteria, AND every effective dep done. Run type='blocked' to see what's gating drafts.";
  const parts = [`${tasks.length} plannable task${tasks.length > 1 ? "s" : ""}:`];
  for (const t of tasks) parts.push(taskLine(t));
  return parts.join("\n");
}
