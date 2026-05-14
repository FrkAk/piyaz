import "server-only";

import {
  getDependencyChain,
  getDownstream,
} from "@/lib/data/traversal";
import {
  fetchDependencyTasks,
  fetchEdgeNotesBySource,
  fetchEdgeNotesByTarget,
  fetchTaskSummaries,
  getTaskFull,
} from "@/lib/data/task";
import { section, formatCriteria, formatDecisions } from "@/lib/context/format";
import type { AuthContext } from "@/lib/auth/context";

/**
 * Build lean, position-optimized context for external coding agents.
 *
 * Sections ordered by U-shaped attention: start/end get highest recall, middle
 * lowest. No token budget — controlled content is compact, implPlan is critical
 * and never truncated.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Formatted context string.
 */
export async function buildAgentContext(
  ctx: AuthContext,
  taskId: string,
): Promise<string> {
  const task = await getTaskFull(ctx, taskId);

  const taskRef = task.taskRef;
  const tags = (task.tags as string[] | null) ?? [];
  const files = (task.files as string[] | null) ?? [];
  const status = task.status as string;
  const priority = task.priority as string | null;
  const estimate = task.estimate as number | null;
  const assignees = task.assignees;
  const links = task.links;

  const [deps, downstream, upstreamEdgeNotes] = await Promise.all([
    getDependencyChain(taskId, task.projectId, 2),
    // getDownstream is public — caller already asserted; pass ctx through
    getDownstream(ctx, taskId, 2),
    fetchEdgeNotesBySource(task.projectId, taskId),
  ]);

  const prLink = links.find((l) => l.kind === "pull_request");

  const headerLines: string[] = [
    `# ${taskRef ? `\`${taskRef}\` ` : ""}${task.title}`,
  ];
  if (tags.length > 0) {
    headerLines.push(`Tags: ${tags.map((t) => `\`${t}\``).join(", ")}`);
  }
  if (priority) headerLines.push(`Priority: \`${priority}\``);
  if (estimate) headerLines.push(`Estimate: ${estimate} pts`);
  if (prLink) headerLines.push(`PR: ${prLink.url}`);
  headerLines.push("");
  headerLines.push(task.description);

  const parts: string[] = [headerLines.join("\n")];

  if (task.implementationPlan && status !== "done" && status !== "cancelled") {
    parts.push(
      section("Implementation Plan") + "\n" + task.implementationPlan,
    );
  }

  if (deps.length > 0) {
    const prereqLines: string[] = [];
    const execLines: string[] = [];

    const depTasks = await fetchDependencyTasks(
      task.projectId,
      deps.map((d) => d.id),
    );
    const depMap = new Map(depTasks.map((dt) => [dt.id, dt]));

    for (const dep of deps) {
      const info = depMap.get(dep.id);
      if (!info) continue;
      const note = upstreamEdgeNotes.get(dep.id);
      let line = `- \`${info.taskRef}\` **${info.title}** [${info.status}]`;
      if (note) line += ` — ${note}`;
      prereqLines.push(line);

      if (info.executionRecord) {
        execLines.push(`### \`${info.taskRef}\` ${info.title}`);
        execLines.push(info.executionRecord);
      }
    }

    if (prereqLines.length > 0) {
      parts.push(
        section("Prerequisites (context only — do NOT implement these)") +
          "\n" +
          prereqLines.join("\n"),
      );
    }

    if (execLines.length > 0) {
      parts.push(
        section("Upstream Execution Records") + "\n" + execLines.join("\n"),
      );
    }
  }

  if (task.decisions.length > 0) {
    parts.push(section("Constraints") + "\n" + formatDecisions(task.decisions));
  }

  parts.push(
    section("Done Means") + "\n" + formatCriteria(task.acceptanceCriteria),
  );

  if (files.length > 0) {
    parts.push(
      section("Files") + "\n" + files.map((f) => `- ${f}`).join("\n"),
    );
  }

  if (assignees.length > 0) {
    parts.push(
      section("Assignees") +
        "\n" +
        assignees.map((a) => `- ${a.name} <${a.email}>`).join("\n"),
    );
  }

  if (links.length > 0) {
    const linkLines = links.map((l) => {
      let host = "";
      try {
        host = new URL(l.url).host;
      } catch {
        host = l.url;
      }
      const display = l.label ?? host;
      return `- [${l.kind}] ${display} (${l.url})`;
    });
    parts.push(section("Links") + "\n" + linkLines.join("\n"));
  }

  if (
    task.executionRecord &&
    (status === "done" || status === "cancelled" || status === "in_review")
  ) {
    parts.push(section("Execution Record") + "\n" + task.executionRecord);
  }

  if (downstream.length > 0) {
    const [downstreamEdgeNotes, downstreamSummaries] = await Promise.all([
      fetchEdgeNotesByTarget(task.projectId, taskId),
      fetchTaskSummaries(
        task.projectId,
        downstream.map((d) => d.id),
      ),
    ]);
    const summaryMap = new Map(downstreamSummaries.map((s) => [s.id, s]));
    const downLines: string[] = [];

    for (const d of downstream) {
      const info = summaryMap.get(d.id);
      if (!info) continue;
      const note = downstreamEdgeNotes.get(d.id);
      let line = `- \`${info.taskRef}\` **${info.title}** [${info.status}]`;
      if (note) line += ` — ${note}`;
      downLines.push(line);
    }

    if (downLines.length > 0) {
      parts.push(
        section("Downstream (what depends on this task's output)") +
          "\n" +
          downLines.join("\n"),
      );
    }
  }

  return parts.join("\n\n");
}
