import "server-only";

import {
  buildDepAdjacency,
  walkEffectiveDepsBounded,
} from "@/lib/graph/effective-deps";
import {
  fetchDependencyTasks,
  fetchEdgeNotesBySource,
  fetchEdgeNotesByTarget,
  fetchTaskSummaries,
  getTaskFullTx,
} from "@/lib/data/task";
import { getProjectHeader } from "@/lib/data/project";
import { section, formatCriteria, formatDecisions } from "@/lib/context/format";
import type { AuthContext } from "@/lib/auth/context";
import { withUserContext } from "@/lib/db/rls";

/**
 * Build planning-optimized context for a task.
 *
 * Supplies the project-level breadth a planner can't derive from reading code
 * alone: project description, upstream execution records, and downstream task
 * specs. Sections ordered by U-shaped attention. No token budget — all content
 * included as-is.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Formatted planning context string.
 */
export async function buildPlanningContext(
  ctx: AuthContext,
  taskId: string,
): Promise<string> {
  return withUserContext(ctx.userId, async (tx) => {
    const task = await getTaskFullTx(tx, taskId);

    const { adj, taskStatus } = await buildDepAdjacency(task.projectId, tx);
    const reverseAdj = new Map<string, string[]>();
    for (const [src, targets] of adj) {
      for (const t of targets) {
        const list = reverseAdj.get(t) ?? [];
        list.push(src);
        reverseAdj.set(t, list);
      }
    }
    const deps = [
      ...walkEffectiveDepsBounded(taskId, adj, taskStatus, 2).keys(),
    ].map((id) => ({ id }));
    const downstream = [
      ...walkEffectiveDepsBounded(taskId, reverseAdj, taskStatus, 2).keys(),
    ].map((id) => ({ id }));

    const project = await getProjectHeader(task.projectId, tx);
    if (!project) {
      console.error("Task has no joinable project", {
        taskId: task.id,
        projectId: task.projectId,
      });
    }
    const tags = (task.tags as string[] | null) ?? [];
    const priority = task.priority as string | null;
    const estimate = task.estimate as number | null;
    const taskRef = task.taskRef;

    const headerLines: string[] = [
      `# ${taskRef ? `\`${taskRef}\` ` : ""}${task.title}`,
    ];
    if (tags.length > 0) {
      headerLines.push(`Tags: ${tags.map((t) => `\`${t}\``).join(", ")}`);
    }
    if (priority) headerLines.push(`Priority: \`${priority}\``);
    if (estimate) headerLines.push(`Estimate: ${estimate} pts`);

    const parts: string[] = [headerLines.join("\n")];

    if (project) {
      const projectLines = [`Project: ${project.title}`];
      if (project.description) {
        projectLines.push(project.description);
      }
      parts.push(section("Project Context") + "\n" + projectLines.join("\n"));
    }

    parts.push(section("Description") + "\n" + task.description);
    parts.push(
      section("Acceptance Criteria") +
        "\n" +
        formatCriteria(task.acceptanceCriteria),
    );

    if (task.implementationPlan) {
      parts.push(
        section("Existing Implementation Plan") +
          "\n" +
          task.implementationPlan,
      );
    }

    const upstreamEdgeNotes = await fetchEdgeNotesBySource(
      task.projectId,
      taskId,
      tx,
    );

    if (deps.length > 0) {
      const prereqLines: string[] = [];
      const execLines: string[] = [];

      const depTasks = await fetchDependencyTasks(
        task.projectId,
        deps.map((d) => d.id),
        tx,
      );
      const depMap = new Map(depTasks.map((dt) => [dt.id, dt]));

      for (const dep of deps) {
        const info = depMap.get(dep.id);
        if (!info) continue;
        const note = upstreamEdgeNotes.get(dep.id);
        let line = `- \`${info.taskRef}\` **${info.title}** [${info.status}]`;
        if (note) line += ` — ${note}`;
        prereqLines.push(line);

        if (info.status === "done" && info.executionRecord) {
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
          section("What's Been Built (from done prerequisites)") +
            "\n" +
            execLines.join("\n"),
        );
      }
    }

    if (task.decisions.length > 0) {
      parts.push(section("Decisions") + "\n" + formatDecisions(task.decisions));
    }

    if (downstream.length > 0) {
      const [downstreamEdgeNotes, downstreamSummaries] = await Promise.all([
        fetchEdgeNotesByTarget(task.projectId, taskId, tx),
        fetchTaskSummaries(
          task.projectId,
          downstream.map((d) => d.id),
          tx,
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
        if (info.description) line += `\n  ${info.description}`;
        downLines.push(line);
      }

      if (downLines.length > 0) {
        parts.push(
          section("Downstream (tasks that depend on this task's output)") +
            "\n" +
            downLines.join("\n"),
        );
      }
    }

    return parts.join("\n\n");
  });
}
