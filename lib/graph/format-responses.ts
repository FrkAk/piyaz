/**
 * Formatters that convert tool handler responses to token-efficient text.
 * Used by shared handlers so both web AI SDK and MCP get identical output.
 */

import type {
  McpSearchItem,
  McpSearchPage,
  SearchResult,
  TaskSlim,
} from "@/lib/data/task";
import type { DetailedEdge } from "@/lib/data/edge";
import type {
  Neighbor,
  ReadyTask,
  PlannableTask,
  BlockedTask,
  CriticalPathTask,
  DownstreamNode,
} from "@/lib/data/traversal";
import type { ActivityEvent } from "@/lib/types";
import type { Whoami } from "@/lib/data/account";
import type { TeamMemberEntry } from "@/lib/data/membership";
import type { UserTeamEntry } from "@/lib/data/project";
import type { ProjectOverview } from "@/lib/context/_core/overview";
import type { SummaryContext } from "@/lib/context/_core/summary";
import { capLines, untrustedContentNotice } from "@/lib/context/format";
import { budgetLines } from "@/lib/mcp/budget";
import type { ProjectMeta } from "@/lib/data/views";

const STATUS_ORDER = [
  "in_progress",
  "in_review",
  "planned",
  "draft",
  "done",
  "cancelled",
] as const;

/**
 * Format a task as a compact single line.
 * @param t - Task with id, title, status, and optional state/tags/category/
 *   priority/estimate/assignees. `state` renders as `[status|state]`.
 * @returns Formatted line string.
 */
function taskLine(t: {
  id: string;
  taskRef: string;
  title: string;
  status: string;
  state?: string | null;
  tags?: string[];
  category?: string | null;
  priority?: string | null;
  estimate?: number | null;
  assigneeCount?: number;
}): string {
  const stateSuffix = t.state ? `|${t.state}` : "";
  let line = `- \`${t.taskRef}\` "${t.title}" [${t.status}${stateSuffix}] \`${t.id}\``;
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
function renderGrouped<T extends { status: string }>(
  tasks: T[],
  renderLine: (t: T) => string,
): string {
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
 * Format summary context as compact markdown. Prefixed with the
 * untrusted-content notice — the description and edge notes are
 * user-authored free text served straight into agent context, the same
 * exposure the agent/planning/review/working bundles carry.
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
  if (ctx.edgeCount.depends_on > 0)
    stats.push(`${ctx.edgeCount.depends_on} depends_on`);
  if (ctx.edgeCount.relates_to > 0)
    stats.push(`${ctx.edgeCount.relates_to} relates_to`);
  stats.push(
    `${ctx.acceptanceCriteriaCount} criteria`,
    `${ctx.decisionsCount} decisions`,
  );
  if (ctx.node.category) stats.push(`category: ${ctx.node.category}`);
  if (ctx.node.priority) stats.push(`priority: ${ctx.node.priority}`);
  if (ctx.node.estimate) stats.push(`${ctx.node.estimate}pts`);
  if (ctx.assigneeCount > 0) stats.push(`${ctx.assigneeCount} assigned`);
  if (ctx.hasImplementationPlan) stats.push("has plan");
  parts.push(`\n${stats.join(" | ")}`);
  if (ctx.node.prUrl) parts.push(`PR: ${ctx.node.prUrl}`);

  if (ctx.edges.length > 0) {
    parts.push("\n## Edges");
    const edgeLines = ctx.edges.map((e) => {
      const arrow = e.direction === "outgoing" ? "\u2192" : "\u2190";
      let line = `- ${e.edgeType} ${arrow} \`${e.connectedTaskRef}\` "${e.connectedTaskTitle}" [${e.connectedTaskStatus}] \`${e.connectedTaskId}\``;
      if (e.note) line += ` \u2014 ${e.note}`;
      return line;
    });
    parts.push(
      ...capLines(
        edgeLines,
        `run piyaz_map view='neighbors'${ctx.node.taskRef ? ` task='${ctx.node.taskRef}'` : ""} for the full list.`,
      ),
    );
  }
  return untrustedContentNotice() + "\n\n" + parts.join("\n");
}

/**
 * Format search results as compact text with optional state hint.
 * @param results - Search result array.
 * @param hint - Optional state hint for single-result searches.
 * @returns Formatted text with one result per line.
 */
export function formatSearchResults(
  results: SearchResult[],
  hint?: string,
): string {
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
  const parts: string[] = [
    `${edges.length} edge${edges.length > 1 ? "s" : ""}:`,
  ];
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
  parts.push(
    meta.categories.length > 0
      ? `Categories: ${meta.categories.join(", ")}`
      : "Categories: (none yet — set with piyaz_workspace action='update' categories=[...])",
  );
  if (meta.tagVocabulary.length > 0) {
    const tagLine = meta.tagVocabulary
      .map((t) => `${t.tag} (${t.count})`)
      .join(", ");
    parts.push(`Tags: ${tagLine}`);
  } else {
    parts.push("Tags: (none in use yet)");
  }
  if (meta.description) parts.push(`\n${meta.description}`);
  return parts.join("\n");
}

/** Options for {@link formatOverview}: per-status task cap and detail knob. */
export type OverviewFormatOpts = {
  /** Per-status task-group cap; groups over it truncate with guidance. */
  limit?: number;
  /** `concise` (default) drops the tag vocabulary line. */
  detail?: "concise" | "detailed";
};

/** Rendered overview plus whether any group was truncated (for logging). */
export type FormattedOverview = { text: string; truncated: boolean };

/** Default per-status task cap for the overview. */
const OVERVIEW_GROUP_LIMIT = 30;

/**
 * Format project overview with progress, tasks by status, and edges.
 * Prefixed with the untrusted-content notice — the project description
 * and edge notes are user-authored free text served straight into agent
 * context, the same exposure the per-task bundles carry.
 *
 * @param overview - ProjectOverview from buildProjectOverview.
 * @param opts - Per-status task cap and detail knob.
 * @returns Rendered markdown plus whether any status group was truncated.
 */
export function formatOverview(
  overview: ProjectOverview,
  opts: OverviewFormatOpts = {},
): FormattedOverview {
  const limit = opts.limit ?? OVERVIEW_GROUP_LIMIT;
  const detail = opts.detail ?? "concise";
  let truncated = false;
  const denominator = overview.totalTasks - overview.cancelledTasks;
  const parts: string[] = [
    `# \`${overview.identifier}\` "${overview.title}" [${overview.status}]`,
    `Progress: ${overview.doneTasks}/${denominator} done (${overview.progress}%) | ${overview.inProgressTasks} in_progress | ${overview.cancelledTasks} cancelled`,
  ];
  if (overview.categories.length > 0)
    parts.push(`Categories: ${overview.categories.join(", ")}`);
  if (detail === "detailed" && overview.tagVocabulary.length > 0)
    parts.push(`Tags: ${overview.tagVocabulary.join(", ")}`);
  if (overview.description) parts.push(`\n${overview.description}`);

  const groups = new Map<string, typeof overview.tasks>();
  for (const t of overview.tasks) {
    const list = groups.get(t.status) ?? [];
    list.push(t);
    groups.set(t.status, list);
  }
  for (const status of STATUS_ORDER) {
    const group = groups.get(status);
    if (!group || group.length === 0) continue;
    parts.push(`\n## ${status} (${group.length})`);
    const lines = group.map((t) => {
      let line = `- \`${t.taskRef}\` "${t.title}" \`${t.id}\``;
      if (t.category) line += ` | ${t.category}`;
      if (t.priority) line += ` | ${t.priority}`;
      if (t.estimate) line += ` | ${t.estimate}pts`;
      if (t.assigneeCount && t.assigneeCount > 0)
        line += ` | ${t.assigneeCount} assigned`;
      return line;
    });
    const budgeted = budgetLines(
      lines,
      limit,
      `narrow with piyaz_search project='${overview.identifier}' status=['${status}']`,
    );
    truncated = truncated || budgeted.truncated;
    parts.push(...budgeted.lines);
  }

  if (overview.edges.length > 0) {
    parts.push(`\n## Dependencies (${overview.edges.length})`);
    const edgeLines = overview.edges.map((e) => {
      let line = `- \`${e.sourceTaskRef}\` "${e.sourceTitle}" ${e.edgeType} \u2192 \`${e.targetTaskRef}\` "${e.targetTitle}"`;
      if (e.note) line += ` \u2014 ${e.note}`;
      return line;
    });
    const budgeted = budgetLines(
      edgeLines,
      limit * 2,
      `walk a specific task's edges with piyaz_map view='neighbors' task='<ref>'`,
    );
    truncated = truncated || budgeted.truncated;
    parts.push(...budgeted.lines);
  }
  return {
    text: untrustedContentNotice() + "\n\n" + parts.join("\n"),
    truncated,
  };
}

/**
 * Format a `piyaz_search` result page: ref-first lines, newest first, with
 * cursor guidance when more pages exist.
 * @param page - Search page from searchTasksForMcp.
 * @param hint - Optional state hint for single-result pages.
 * @returns Formatted text.
 */
export function formatMcpSearchPage(
  page: McpSearchPage,
  hint?: string,
): string {
  const parts: string[] =
    page.items.length === 0
      ? [
          "No results. Widen the query, drop a filter, or check the ref with piyaz_workspace action='projects'.",
        ]
      : [
          `${page.items.length} result${page.items.length > 1 ? "s" : ""} (newest first):`,
        ];
  for (const r of page.items) parts.push(taskLine(r));
  if (page.nextCursor) {
    parts.push(
      `\nMore pages exist. Pass cursor='${String(page.nextCursor)}' for the next page, or narrow with filters.`,
    );
  }
  if (hint) parts.push(`\n> ${hint}`);
  return parts.join("\n");
}

/**
 * Format a `piyaz_map view='neighbors'` walk, hop-grouped, ref-first.
 * @param neighbors - Neighbor rows from getNeighbors.
 * @param originRef - Ref or id of the origin task, for the header.
 * @returns Formatted text.
 */
export function formatNeighbors(
  neighbors: Neighbor[],
  originRef: string,
): string {
  if (neighbors.length === 0)
    return `No edges on ${originRef}. Wire dependencies with piyaz_link; bare tasks orphan from critical_path and downstream.`;
  const parts: string[] = [`Neighbors of ${originRef}:`];
  for (const hop of [1, 2] as const) {
    const rows = neighbors.filter((n) => n.hop === hop);
    if (rows.length === 0) continue;
    parts.push(`\n## hop ${hop} (${rows.length})`);
    for (const n of rows) {
      const arrow = n.direction === "outgoing" ? "\u2192" : "\u2190";
      let line = `- ${n.edgeType} ${arrow} \`${n.taskRef}\` "${n.title}" [${n.status}] \`${n.id}\``;
      if (n.note) line += ` \u2014 ${n.note}`;
      parts.push(line);
    }
  }
  return parts.join("\n");
}

/**
 * Format an activity page, newest first, with cursor guidance.
 * @param events - Event rows from listProjectActivity / listTaskActivity.
 * @param nextCursor - Cursor for the next page, or null when exhausted.
 * @returns Formatted text.
 */
export function formatActivityPage(
  events: ActivityEvent[],
  nextCursor: string | null,
): string {
  if (events.length === 0) return "No activity in range.";
  const parts: string[] = [`${events.length} events (newest first):`];
  for (const e of events) {
    const actor = e.actorName ?? e.agent ?? "unknown";
    let line = `- ${e.createdAt} [${e.type}] ${actor}: ${e.summary}`;
    if (e.targetRef) line += ` \`${e.targetRef}\``;
    parts.push(line);
  }
  if (nextCursor) {
    parts.push(
      `\nMore events exist. Pass cursor='${nextCursor}' for the next page, or tighten since.`,
    );
  }
  return parts.join("\n");
}

/**
 * Format the `piyaz_workspace action='whoami'` response.
 * @param who - Caller profile.
 * @param teams - The caller's team memberships.
 * @returns Formatted text.
 */
export function formatWhoami(who: Whoami, teams: UserTeamEntry[]): string {
  const parts = [
    `You are ${who.name} \`${who.userId}\` (${teams.length} team${teams.length === 1 ? "" : "s"}).`,
  ];
  if (teams.length === 0) {
    parts.push(
      "No team membership. Ask the user to sign in to the web app and create or join a team.",
    );
  } else {
    parts.push(
      "Next: piyaz_workspace action='projects' to enumerate projects.",
    );
  }
  return parts.join("\n");
}

/** Row cap for the members directory; large orgs truncate with guidance. */
const MEMBER_LIST_LIMIT = 100;

/**
 * Format the `piyaz_workspace action='members'` directory: one line per
 * member with the user UUID (the assignment handle) and role, capped at
 * {@link MEMBER_LIST_LIMIT}, closing with the assignment-parameter cue.
 *
 * @param members - Members from listTeamMembers.
 * @returns Formatted text plus the truncation flag for the call log.
 */
export function formatTeamMembers(members: TeamMemberEntry[]): {
  text: string;
  truncated: boolean;
} {
  const lines = members.map((m) => `- ${m.name} \`${m.userId}\` (${m.role})`);
  const budgeted = budgetLines(
    lines,
    MEMBER_LIST_LIMIT,
    "match the teammate by name with the user, or find them on a task via piyaz_get fields=['assignees']",
  );
  const parts = [
    `${members.length} team member${members.length === 1 ? "" : "s"}:`,
    ...budgeted.lines,
    "",
    "> Use the UUID as assigneeIds on piyaz_create, op='add'/'remove' collection='assignees' on piyaz_edit, or assignee='<uuid>' on piyaz_search.",
  ];
  return { text: parts.join("\n"), truncated: budgeted.truncated };
}

/**
 * Format ready tasks list.
 * @param tasks - Ready task array from getReadyTasks.
 * @returns Formatted text, includes hint when empty.
 */
export function formatReadyTasks(tasks: ReadyTask[]): string {
  if (tasks.length === 0)
    return "No ready tasks.\n\n> Run piyaz_map view='plannable' to find tasks to plan, or view='blocked' for blockers.";
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
  const parts: string[] = [
    `${tasks.length} blocked task${tasks.length > 1 ? "s" : ""}:`,
  ];
  for (const t of tasks) {
    parts.push(`- \`${t.taskRef}\` "${t.title}" [${t.status}] \`${t.id}\``);
    for (const b of t.blockedBy)
      parts.push(
        `  blocked by: \`${b.taskRef}\` "${b.title}" [${b.status}] \`${b.id}\``,
      );
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
  const parts = [
    `${nodes.length} downstream task${nodes.length > 1 ? "s" : ""}:`,
  ];
  for (const n of nodes)
    parts.push(`- depth ${n.depth}: \`${n.taskRef}\` "${n.title}" \`${n.id}\``);
  return parts.join("\n");
}

/**
 * Format critical path as numbered chain.
 * @param tasks - CriticalPathTask array forming the longest chain.
 * @returns Formatted numbered list.
 */
export function formatCriticalPath(tasks: CriticalPathTask[]): string {
  if (tasks.length === 0)
    return "No critical path found (no dependency chains).";
  const parts = [
    `Critical path (${tasks.length} task${tasks.length > 1 ? "s" : ""}):`,
  ];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    parts.push(
      `${i + 1}. \`${t.taskRef}\` "${t.title}" [${t.status}] \`${t.id}\``,
    );
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
    return "No plannable tasks.\n\n> Drafts must have description, acceptance criteria, AND every effective dep done. Run piyaz_map view='blocked' to see what's gating drafts.";
  const parts = [
    `${tasks.length} plannable task${tasks.length > 1 ? "s" : ""}:`,
  ];
  for (const t of tasks) parts.push(taskLine(t));
  return parts.join("\n");
}
