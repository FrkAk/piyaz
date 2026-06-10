import "server-only";

import { section, formatCriteria, formatDecisions } from "@/lib/context/format";
import type { AuthContext } from "@/lib/auth/context";
import { withUserContext } from "@/lib/db/rls";
import {
  resolvePlanningData,
  type PlanningContextData,
} from "@/lib/context/_core/bundle";

/**
 * Assemble the planning context string from pre-resolved planning data.
 *
 * Supplies the project-level breadth a planner can't derive from reading code
 * alone: project description, upstream execution records, and downstream task
 * specs. Sections ordered by U-shaped attention. Pure: reads only its
 * argument, issues no queries.
 *
 * @param data Resolved planning data (dependency closure plus project header).
 * @returns Formatted planning context string.
 */
export function buildPlanningContextFrom(data: PlanningContextData): string {
  const { task, deps, downstream, upstreamEdgeNotes, depTasks, project } = data;

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
      section("Existing Implementation Plan") + "\n" + task.implementationPlan,
    );
  }

  if (deps.length > 0) {
    const prereqLines: string[] = [];
    const execLines: string[] = [];

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
    const summaryMap = new Map(data.downstreamSummaries.map((s) => [s.id, s]));
    const downLines: string[] = [];

    for (const d of downstream) {
      const info = summaryMap.get(d.id);
      if (!info) continue;
      const note = data.downstreamEdgeNotes.get(d.id);
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
}

/**
 * Build planning-optimized context for a task.
 *
 * The MCP `mymir_context` entry point. Resolves only the planning data this
 * depth renders, then delegates to the pure {@link buildPlanningContextFrom}
 * assembler.
 *
 * @param ctx Resolved auth context.
 * @param taskId UUID of the task.
 * @returns Formatted planning context string.
 */
export async function buildPlanningContext(
  ctx: AuthContext,
  taskId: string,
): Promise<string> {
  return withUserContext(ctx.userId, async (tx) => {
    const data = await resolvePlanningData(tx, taskId);
    return buildPlanningContextFrom(data);
  });
}
