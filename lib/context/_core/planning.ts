import "server-only";

import {
  section,
  formatCriteria,
  formatDecisions,
  formatLinkLine,
  formatRelatedEdgeLine,
  formatTaskRefLine,
  untrustedContentNotice,
} from "@/lib/context/format";
import { joinParts, type BundlePart } from "@/lib/context/parts";
import type { AuthContext } from "@/lib/auth/context";
import {
  resolvePlanningData,
  type PlanningContextData,
} from "@/lib/context/_core/bundle";

/**
 * Assemble the planning context as structured bundle parts.
 *
 * Supplies the project-level breadth a planner can't derive from reading code
 * alone: project description, upstream execution records, abandoned
 * approaches from cancelled deps, and downstream task specs. Sections ordered
 * by U-shaped attention. Pure: reads only its argument, issues no queries.
 *
 * @param data Resolved planning data (dependency closure plus project header).
 * @returns Ordered bundle parts; join with {@link joinParts} for markdown.
 */
export function buildPlanningContextParts(
  data: PlanningContextData,
): BundlePart[] {
  const {
    task,
    deps,
    downstream,
    upstreamEdgeNotes,
    depTasks,
    project,
    abandonedDeps,
  } = data;

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
  if (task.category) headerLines.push(`Category: \`${task.category}\``);
  if (tags.length > 0) {
    headerLines.push(`Tags: ${tags.map((t) => `\`${t}\``).join(", ")}`);
  }
  if (priority) headerLines.push(`Priority: \`${priority}\``);
  if (estimate) headerLines.push(`Estimate: ${estimate} pts`);

  const parts: BundlePart[] = [
    {
      id: "notice",
      heading: null,
      markdown: untrustedContentNotice("planning"),
    },
    { id: "header", heading: null, markdown: headerLines.join("\n") },
  ];

  if (project) {
    const projectLines = [`Project: ${project.title}`];
    if (project.description) {
      projectLines.push(project.description);
    }
    parts.push({
      id: "project",
      heading: "Project Context",
      markdown: section("Project Context") + "\n" + projectLines.join("\n"),
    });
  }

  parts.push({
    id: "spec",
    heading: "Description",
    markdown: section("Description") + "\n" + task.description,
  });
  parts.push({
    id: "criteria",
    heading: "Acceptance Criteria",
    markdown:
      section("Acceptance Criteria") +
      "\n" +
      formatCriteria(task.acceptanceCriteria),
  });

  if (task.implementationPlan) {
    parts.push({
      id: "plan",
      heading: "Existing Implementation Plan",
      markdown:
        section("Existing Implementation Plan") +
        "\n" +
        task.implementationPlan,
    });
  }

  if (task.executionRecord) {
    parts.push({
      id: "work-so-far",
      heading: "Work So Far",
      markdown: section("Work So Far") + "\n" + task.executionRecord,
    });
  }

  if (deps.length > 0) {
    const prereqLines: string[] = [];
    const execLines: string[] = [];

    const depMap = new Map(depTasks.map((dt) => [dt.id, dt]));

    for (const dep of deps) {
      const info = depMap.get(dep.id);
      if (!info) continue;
      prereqLines.push(formatTaskRefLine(info, upstreamEdgeNotes.get(dep.id)));

      if (info.status === "done" && info.executionRecord) {
        execLines.push(`### \`${info.taskRef}\` ${info.title}`);
        if (info.prUrl) execLines.push(`PR: ${info.prUrl}`);
        execLines.push(info.executionRecord);
      }
    }

    if (data.depsTruncated) {
      prereqLines.push(
        "… prerequisite chain continues beyond depth 2 — walk further with piyaz_map view='neighbors' hops=2.",
      );
    }

    if (prereqLines.length > 0) {
      parts.push({
        id: "prerequisites",
        heading: "Prerequisites (context only — do NOT implement these)",
        markdown:
          section("Prerequisites (context only — do NOT implement these)") +
          "\n" +
          prereqLines.join("\n"),
      });
    }

    if (execLines.length > 0) {
      parts.push({
        id: "built",
        heading: "What's Been Built (from done prerequisites)",
        markdown:
          section("What's Been Built (from done prerequisites)") +
          "\n" +
          execLines.join("\n"),
      });
    }
  }

  if (abandonedDeps.length > 0) {
    const abandonedLines: string[] = [];
    for (const d of abandonedDeps) {
      abandonedLines.push(`### \`${d.taskRef}\` ${d.title}`);
      if (d.prUrl) abandonedLines.push(`PR: ${d.prUrl} — closed, unmerged`);
      abandonedLines.push(d.executionRecord ?? "");
    }
    parts.push({
      id: "abandoned",
      heading: "Abandoned Approaches",
      markdown:
        section("Abandoned Approaches") + "\n" + abandonedLines.join("\n"),
    });
  }

  if (task.decisions.length > 0) {
    parts.push({
      id: "decisions",
      heading: "Decisions",
      markdown: section("Decisions") + "\n" + formatDecisions(task.decisions),
    });
  }

  if (task.links.length > 0) {
    parts.push({
      id: "links",
      heading: "Links",
      markdown:
        section("Links") + "\n" + task.links.map(formatLinkLine).join("\n"),
    });
  }

  if (downstream.length > 0) {
    const summaryMap = new Map(data.downstreamSummaries.map((s) => [s.id, s]));
    const downLines: string[] = [];

    for (const d of downstream) {
      const info = summaryMap.get(d.id);
      if (!info) continue;
      let line = formatTaskRefLine(info, data.downstreamEdgeNotes.get(d.id));
      if (info.description) line += `\n  ${info.description}`;
      downLines.push(line);
    }

    if (data.downstreamTruncated) {
      downLines.push(
        `… deeper dependents exist beyond depth 2 — run piyaz_map view='downstream'${taskRef ? ` task='${taskRef}'` : ""} for the full transitive set.`,
      );
    }

    if (downLines.length > 0) {
      parts.push({
        id: "downstream",
        heading: "Downstream (tasks that depend on this task's output)",
        markdown:
          section("Downstream (tasks that depend on this task's output)") +
          "\n" +
          downLines.join("\n"),
      });
    }
  }

  if (data.related.length > 0) {
    parts.push({
      id: "related",
      heading: "Related (non-blocking)",
      markdown:
        section("Related (non-blocking)") +
        "\n" +
        data.related.map(formatRelatedEdgeLine).join("\n"),
    });
  }

  return parts;
}

/**
 * Assemble the planning context string from pre-resolved planning data.
 *
 * @param data Resolved planning data (dependency closure plus project header).
 * @returns Formatted planning context string.
 */
export function buildPlanningContextFrom(data: PlanningContextData): string {
  return joinParts(buildPlanningContextParts(data));
}

/**
 * Build planning-optimized context for a task.
 *
 * The MCP `piyaz_context` entry point. Resolves only the planning data this
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
  const data = await resolvePlanningData(ctx.userId, taskId);
  return buildPlanningContextFrom(data);
}
