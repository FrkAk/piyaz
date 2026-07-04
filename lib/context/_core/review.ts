import "server-only";

import {
  capLines,
  MAX_BUNDLE_RECORD_BLOCKS,
  section,
  formatCriteria,
  formatDecisions,
  formatLinkLine,
  formatTaskRefLine,
  untrustedContentNotice,
} from "@/lib/context/format";
import { joinParts, type BundlePart } from "@/lib/context/parts";
import { REVIEW_LENS_PROMPTS } from "@/lib/context/lens";
import type { AuthContext } from "@/lib/auth/context";
import {
  resolveReviewData,
  type ReviewContextData,
} from "@/lib/context/_core/bundle";

/** Footer nudge pointing reviewers at the PR diff as the source of truth. */
const REVIEW_PR_NUDGE =
  "Recorded fields summarize the work; the diff itself is not included and no file list is recorded here. Review the actual changes from the PR linked above — the PR diff, not this record, is the source of truth for what changed.";

/**
 * Assemble the review context as structured bundle parts.
 *
 * Renders `implementationPlan` alongside `executionRecord`, surfaces the
 * PR handle from `task_links` filtered to `kind='pull_request'`, lists
 * downstream tasks whose edge notes may need a refresh after merge, and
 * emits review-lens prompt scaffolding so the reviewer agent can return a
 * structured verdict without re-deriving any of the substrate. Recorded
 * file lists are deliberately absent: the PR diff is the source of truth
 * for what changed, and the nudge after the execution record says so. The
 * bundle does not itself produce a verdict; consumers (the `review` agent)
 * read it.
 *
 * Status check is soft: when the task is not at `in_review` a header note
 * tells the reader the dispatch may be premature, but the bundle still
 * renders so a manual review of an in-flight task remains possible. Pure:
 * reads only its argument, issues no queries.
 *
 * @param data Resolved review data (closure at review depth plus project header).
 * @returns Ordered bundle parts; join with {@link joinParts} for markdown.
 */
export function buildReviewContextParts(data: ReviewContextData): BundlePart[] {
  const { task, deps, downstream, upstreamEdgeNotes, depTasks, project } = data;

  if (!project) {
    console.error("Task has no joinable project", {
      taskId: task.id,
      projectId: task.projectId,
    });
  }
  const tags = (task.tags as string[] | null) ?? [];
  const status = task.status as string;
  const priority = task.priority as string | null;
  const estimate = task.estimate as number | null;
  const taskRef = task.taskRef;
  const links = task.links;

  const prLink = links.find((l) => l.kind === "pull_request");

  const headerLines: string[] = [
    `# ${taskRef ? `\`${taskRef}\` ` : ""}${task.title}`,
  ];
  if (task.category) headerLines.push(`Category: \`${task.category}\``);
  if (tags.length > 0) {
    headerLines.push(`Tags: ${tags.map((t) => `\`${t}\``).join(", ")}`);
  }
  if (priority) headerLines.push(`Priority: \`${priority}\``);
  if (estimate) headerLines.push(`Estimate: ${estimate} pts`);
  headerLines.push(`Status: \`${status}\``);
  headerLines.push(
    prLink
      ? `PR: ${prLink.url}`
      : "PR: (no `pull_request` link on task; pass the URL in dispatch or check upstream)",
  );

  const parts: BundlePart[] = [
    { id: "notice", heading: null, markdown: untrustedContentNotice("review") },
  ];

  if (status !== "in_review") {
    parts.push({
      id: "status-note",
      heading: null,
      markdown: `> **Note:** task status is \`${status}\`, not \`in_review\`. The review bundle is meant for \`in_review\` tasks; confirm the dispatch is intentional before producing a verdict.`,
    });
  }

  parts.push({ id: "header", heading: null, markdown: headerLines.join("\n") });

  if (project) {
    const projectLines = [`Project: ${project.title}`];
    if (project.description) projectLines.push(project.description);
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
    heading: "Acceptance Criteria (as evaluated by implementer)",
    markdown:
      section("Acceptance Criteria (as evaluated by implementer)") +
      "\n" +
      formatCriteria(task.acceptanceCriteria),
  });

  parts.push({
    id: "plan",
    heading: "Implementation Plan (as planned)",
    markdown:
      section("Implementation Plan (as planned)") +
      "\n" +
      (task.implementationPlan ??
        "None recorded. Reconcile the diff against the task description and acceptance criteria instead."),
  });

  parts.push({
    id: "execution",
    heading: "Execution Record (as built)",
    markdown:
      section("Execution Record (as built)") +
      "\n" +
      (task.executionRecord ??
        "None recorded. The implementer must populate this before review can proceed."),
  });

  parts.push({ id: "nudge", heading: null, markdown: REVIEW_PR_NUDGE });

  if (task.decisions.length > 0) {
    parts.push({
      id: "decisions",
      heading: "Decisions",
      markdown: section("Decisions") + "\n" + formatDecisions(task.decisions),
    });
  }

  if (links.length > 0) {
    parts.push({
      id: "links",
      heading: "Links",
      markdown: section("Links") + "\n" + links.map(formatLinkLine).join("\n"),
    });
  }

  if (deps.length > 0) {
    const rawPrereqLines: string[] = [];
    const execLines: string[] = [];
    let recordCount = 0;

    const depMap = new Map(depTasks.map((dt) => [dt.id, dt]));

    for (const dep of deps) {
      const info = depMap.get(dep.id);
      if (!info) continue;
      rawPrereqLines.push(
        formatTaskRefLine(info, upstreamEdgeNotes.get(dep.id)),
      );

      // Deliberately no upstream PR links here (unlike agent/planning): the
      // reviewer's artifact is the current task's PR, and extra upstream
      // URLs dilute attention on it.
      if (info.status === "done" && info.executionRecord) {
        recordCount++;
        if (recordCount <= MAX_BUNDLE_RECORD_BLOCKS) {
          execLines.push(`### \`${info.taskRef}\` ${info.title}`);
          execLines.push(info.executionRecord);
        }
      }
    }
    if (recordCount > MAX_BUNDLE_RECORD_BLOCKS) {
      execLines.push(
        `… +${recordCount - MAX_BUNDLE_RECORD_BLOCKS} more upstream records — fetch one with piyaz_get task='<dep ref>' fields=['executionRecord'].`,
      );
    }

    const prereqLines = capLines(
      rawPrereqLines,
      "walk the rest with piyaz_map view='neighbors' hops=2.",
    );
    if (prereqLines.length > 0) {
      parts.push({
        id: "prerequisites",
        heading: "Prerequisites",
        markdown: section("Prerequisites") + "\n" + prereqLines.join("\n"),
      });
    }
    if (execLines.length > 0) {
      parts.push({
        id: "built",
        heading: "Upstream Execution Records",
        markdown:
          section("Upstream Execution Records") + "\n" + execLines.join("\n"),
      });
    }
  }

  if (downstream.length > 0) {
    const summaryMap = new Map(data.downstreamSummaries.map((s) => [s.id, s]));
    const rawDownLines: string[] = [];

    for (const d of downstream) {
      const info = summaryMap.get(d.id);
      if (!info) continue;
      rawDownLines.push(
        formatTaskRefLine(info, data.downstreamEdgeNotes.get(d.id)),
      );
    }

    const downLines = capLines(
      rawDownLines,
      `run piyaz_map view='downstream'${taskRef ? ` task='${taskRef}'` : ""} for the full transitive set.`,
    );
    if (downLines.length > 0) {
      parts.push({
        id: "downstream",
        heading: "Downstream Impact (edges to refresh after merge)",
        markdown:
          section("Downstream Impact (edges to refresh after merge)") +
          "\n" +
          downLines.join("\n"),
      });
    }
  }

  parts.push({
    id: "lens",
    heading: "Review Lens Prompts",
    markdown: section("Review Lens Prompts") + "\n" + REVIEW_LENS_PROMPTS,
  });

  return parts;
}

/**
 * Assemble the review context string from pre-resolved review data.
 *
 * @param data Resolved review data.
 * @returns Formatted review context string.
 */
export function buildReviewContextFrom(data: ReviewContextData): string {
  return joinParts(buildReviewContextParts(data));
}

/**
 * Build review-optimized context for an `in_review` task.
 *
 * The MCP `piyaz_get lens='review'` entry point. Resolves only the
 * review data this depth renders, then delegates to the pure
 * {@link buildReviewContextFrom} assembler.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Formatted review context string.
 */
export async function buildReviewContext(
  ctx: AuthContext,
  taskId: string,
): Promise<string> {
  return buildReviewContextFrom(await resolveReviewData(ctx.userId, taskId));
}
