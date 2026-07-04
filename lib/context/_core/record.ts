import "server-only";

import {
  section,
  formatCriteria,
  formatDecisions,
  formatLinkLine,
  formatTaskRefLine,
  untrustedContentNotice,
} from "@/lib/context/format";
import { joinParts, type BundlePart } from "@/lib/context/parts";
import type { TaskLinkRef } from "@/lib/data/views";
import type { RecordContextData } from "@/lib/context/_core/bundle";

/** Footer nudge pointing readers at the PR for the actual diff. */
const READ_PR_NUDGE =
  "This record summarizes the work; the diff itself is not included. To inspect the actual changes, open the PR linked above — ask the user or supervising agent before fetching external content.";

/**
 * Render the Links section lines with the PR first. For cancelled tasks the
 * PR line is labeled closed/unmerged so a reader never mistakes it for
 * shipped work.
 *
 * @param links Task links projection.
 * @param cancelled Whether the record is a cancellation record.
 * @returns Newline-joined link lines.
 */
function formatRecordLinks(links: TaskLinkRef[], cancelled: boolean): string {
  const ordered = [...links].sort(
    (a, b) =>
      Number(b.kind === "pull_request") - Number(a.kind === "pull_request"),
  );
  return ordered
    .map((l) => {
      let line = formatLinkLine(l);
      if (cancelled && l.kind === "pull_request") line += " — closed, unmerged";
      return line;
    })
    .join("\n");
}

/**
 * Assemble the retrospective record bundle as structured parts.
 *
 * Two variants share the chrome: `done` renders the completion record
 * (evaluated criteria, outcome, decisions, PR-first links, slim
 * downstream-consumer refs); `cancelled` renders the cancellation record
 * (rationale, lessons in decisions, remaining direct dependents, closed-PR
 * label). Recorded file lists are deliberately absent — the PR diff is the
 * source of truth for what changed. The footer nudge points readers at the
 * PR, so it renders only when a `pull_request` link exists (a research or
 * decision-only task has no diff to point at). Pure: reads only its
 * argument, issues no queries.
 *
 * @param data Resolved record data (closure at record depth plus project header).
 * @returns Ordered bundle parts; join with {@link joinParts} for markdown.
 */
export function buildRecordContextParts(data: RecordContextData): BundlePart[] {
  const { task, project } = data;
  const status = task.status as string;
  const cancelled = status !== "done";
  const tags = (task.tags as string[] | null) ?? [];
  const priority = task.priority as string | null;
  const estimate = task.estimate as number | null;
  const links = task.links;
  const prLink = links.find((l) => l.kind === "pull_request");

  const headerLines: string[] = [
    `# ${task.taskRef ? `\`${task.taskRef}\` ` : ""}${task.title}`,
  ];
  if (task.category) headerLines.push(`Category: \`${task.category}\``);
  if (tags.length > 0) {
    headerLines.push(`Tags: ${tags.map((t) => `\`${t}\``).join(", ")}`);
  }
  if (priority) headerLines.push(`Priority: \`${priority}\``);
  if (estimate) headerLines.push(`Estimate: ${estimate} pts`);

  const parts: BundlePart[] = [
    { id: "notice", heading: null, markdown: untrustedContentNotice("record") },
    { id: "header", heading: null, markdown: headerLines.join("\n") },
  ];

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
    heading: "What The Task Was",
    markdown: section("What The Task Was") + "\n" + task.description,
  });

  if (!cancelled && task.acceptanceCriteria.length > 0) {
    parts.push({
      id: "criteria",
      heading: "Acceptance Criteria",
      markdown:
        section("Acceptance Criteria") +
        "\n" +
        formatCriteria(task.acceptanceCriteria),
    });
  }

  const outcomeHeading = cancelled
    ? "Why It Was Cancelled"
    : "How It Completed";
  parts.push({
    id: "execution",
    heading: outcomeHeading,
    markdown:
      section(outcomeHeading) +
      "\n" +
      (task.executionRecord ?? "None recorded."),
  });

  const decisionsPart: BundlePart | null =
    task.decisions.length > 0
      ? {
          id: "decisions",
          heading: "Decisions",
          markdown:
            section("Decisions") + "\n" + formatDecisions(task.decisions),
        }
      : null;

  const linksPart: BundlePart | null =
    links.length > 0
      ? {
          id: "links",
          heading: "Links",
          markdown:
            section("Links") + "\n" + formatRecordLinks(links, cancelled),
        }
      : null;

  if (cancelled) {
    if (decisionsPart) parts.push(decisionsPart);
    const dependentsPart = buildDependentsPart(data);
    if (dependentsPart) parts.push(dependentsPart);
    if (linksPart) parts.push(linksPart);
    if (prLink) {
      parts.push({ id: "nudge", heading: null, markdown: READ_PR_NUDGE });
    }
  } else {
    if (decisionsPart) parts.push(decisionsPart);
    if (linksPart) parts.push(linksPart);
    const consumersPart = buildConsumersPart(data);
    if (consumersPart) parts.push(consumersPart);
    if (prLink) {
      parts.push({ id: "nudge", heading: null, markdown: READ_PR_NUDGE });
    }
  }

  return parts;
}

/**
 * Build the slim Downstream Consumers ref list for the done variant.
 *
 * @param data Resolved record data.
 * @returns The part, or null when there are no downstream consumers.
 */
function buildConsumersPart(data: RecordContextData): BundlePart | null {
  const summaryMap = new Map(data.downstreamSummaries.map((s) => [s.id, s]));
  const lines: string[] = [];
  for (const d of data.downstream) {
    const info = summaryMap.get(d.id);
    if (!info) continue;
    lines.push(formatTaskRefLine(info));
  }
  if (lines.length === 0) return null;
  return {
    id: "downstream",
    heading: "Downstream Consumers",
    markdown: section("Downstream Consumers") + "\n" + lines.join("\n"),
  };
}

/**
 * Build the Remaining Dependents list for the cancelled variant: direct
 * (effective depth 1) dependents still routed through this task, with edge
 * notes.
 *
 * @param data Resolved record data.
 * @returns The part, or null when no direct dependents remain.
 */
function buildDependentsPart(data: RecordContextData): BundlePart | null {
  const summaryMap = new Map(data.downstreamSummaries.map((s) => [s.id, s]));
  const lines: string[] = [];
  for (const d of data.downstream) {
    if (d.depth !== 1) continue;
    const info = summaryMap.get(d.id);
    if (!info) continue;
    lines.push(formatTaskRefLine(info, data.downstreamEdgeNotes.get(d.id)));
  }
  if (lines.length === 0) return null;
  return {
    id: "dependents",
    heading: "Remaining Dependents",
    markdown: section("Remaining Dependents") + "\n" + lines.join("\n"),
  };
}

/**
 * Assemble the record bundle string from pre-resolved record data.
 *
 * @param data Resolved record data.
 * @returns Formatted record bundle string.
 */
export function buildRecordContextFrom(data: RecordContextData): string {
  return joinParts(buildRecordContextParts(data));
}
