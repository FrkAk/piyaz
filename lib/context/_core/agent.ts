import "server-only";

import {
  section,
  formatCriteria,
  formatDecisions,
  untrustedContentNotice,
} from "@/lib/context/format";
import { joinParts, type BundlePart } from "@/lib/context/parts";
import type { AuthContext } from "@/lib/auth/context";
import { withUserContext } from "@/lib/db/rls";
import {
  resolveDependencyClosure,
  type AgentContextData,
} from "@/lib/context/_core/bundle";

/** Task statuses where dispatching an implementer is premature. */
const PRE_DISPATCH_STATUSES = new Set(["draft", "planned", "in_progress"]);

/**
 * Build the blocked-notice markdown when the task must not be implemented
 * yet: status is `draft`, `planned`, or `in_progress` (premature claim) and
 * at least one direct (effective depth 1) prerequisite is not done.
 *
 * @param data Resolved dependency-closure data.
 * @returns Notice markdown, or null when the task is not blocked.
 */
function buildBlockedNotice(data: AgentContextData): string | null {
  const status = data.task.status as string;
  if (!PRE_DISPATCH_STATUSES.has(status)) return null;

  const depMap = new Map(data.depTasks.map((dt) => [dt.id, dt]));
  const depLines: string[] = [];
  for (const dep of data.deps) {
    if (dep.depth !== 1) continue;
    const info = depMap.get(dep.id);
    if (!info || info.status === "done") continue;
    const note = data.upstreamEdgeNotes.get(dep.id);
    let line = `- \`${info.taskRef}\` **${info.title}** [${info.status}]`;
    if (note) line += ` — ${note}`;
    depLines.push(line);
  }
  if (depLines.length === 0) return null;

  const bodyLines: string[] = [];
  if (status === "draft") {
    bodyLines.push(
      "This task is a `draft` with no implementation plan; it must be planned before any implementation.",
    );
  }
  bodyLines.push(
    "This task's prerequisites are not done. Building now means building against unshipped interfaces, and the lifecycle forbids it. Treat this bundle as read-ahead context only.",
  );
  return (
    section("⚠ Blocked — do not implement") +
    "\n" +
    bodyLines.join("\n") +
    "\n" +
    depLines.join("\n")
  );
}

/**
 * Assemble the lean agent context as structured bundle parts.
 *
 * Sections ordered by U-shaped attention: start/end get highest recall,
 * middle lowest; the success contract (Constraints → Done Means) takes the
 * recency position. The description is header-inline. No token budget; the
 * implPlan is critical and never truncated. Pure: reads only its argument,
 * issues no queries.
 *
 * @param data Resolved dependency-closure data.
 * @returns Ordered bundle parts; join with {@link joinParts} for markdown.
 */
export function buildAgentContextParts(data: AgentContextData): BundlePart[] {
  const { task, deps, downstream, upstreamEdgeNotes, depTasks } = data;

  const taskRef = task.taskRef;
  const tags = (task.tags as string[] | null) ?? [];
  const files = (task.files as string[] | null) ?? [];
  const status = task.status as string;
  const priority = task.priority as string | null;
  const estimate = task.estimate as number | null;
  const links = task.links;

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

  const parts: BundlePart[] = [
    { id: "notice", heading: null, markdown: untrustedContentNotice("agent") },
    { id: "header", heading: null, markdown: headerLines.join("\n") },
  ];

  const blocked = buildBlockedNotice(data);
  if (blocked) {
    parts.push({
      id: "blocked",
      heading: "⚠ Blocked — do not implement",
      markdown: blocked,
    });
  }

  if (task.implementationPlan && status !== "done" && status !== "cancelled") {
    parts.push({
      id: "plan",
      heading: "Implementation Plan",
      markdown: section("Implementation Plan") + "\n" + task.implementationPlan,
    });
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

      if (info.executionRecord) {
        execLines.push(`### \`${info.taskRef}\` ${info.title}`);
        execLines.push(info.executionRecord);
      }
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
        heading: "Upstream Execution Records",
        markdown:
          section("Upstream Execution Records") + "\n" + execLines.join("\n"),
      });
    }
  }

  if (files.length > 0) {
    parts.push({
      id: "files",
      heading: "Files",
      markdown: section("Files") + "\n" + files.map((f) => `- ${f}`).join("\n"),
    });
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
    parts.push({
      id: "links",
      heading: "Links",
      markdown: section("Links") + "\n" + linkLines.join("\n"),
    });
  }

  if (task.executionRecord && status === "in_review") {
    parts.push({
      id: "execution",
      heading: "Execution Record",
      markdown: section("Execution Record") + "\n" + task.executionRecord,
    });
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
      downLines.push(line);
    }

    if (downLines.length > 0) {
      parts.push({
        id: "downstream",
        heading: "Downstream (what depends on this task's output)",
        markdown:
          section("Downstream (what depends on this task's output)") +
          "\n" +
          downLines.join("\n"),
      });
    }
  }

  if (task.decisions.length > 0) {
    parts.push({
      id: "constraints",
      heading: "Constraints",
      markdown: section("Constraints") + "\n" + formatDecisions(task.decisions),
    });
  }

  parts.push({
    id: "criteria",
    heading: "Done Means",
    markdown:
      section("Done Means") + "\n" + formatCriteria(task.acceptanceCriteria),
  });

  return parts;
}

/**
 * Assemble the lean agent context string from pre-resolved dependency data.
 *
 * @param data Resolved dependency-closure data.
 * @returns Formatted context string.
 */
export function buildAgentContextFrom(data: AgentContextData): string {
  return joinParts(buildAgentContextParts(data));
}

/**
 * Build lean, position-optimized context for external coding agents.
 *
 * The MCP `mymir_context` entry point. Resolves only the dependency-closure
 * data this depth renders, then delegates to the pure
 * {@link buildAgentContextFrom} assembler.
 *
 * @param ctx Resolved auth context.
 * @param taskId UUID of the task.
 * @returns Formatted context string.
 */
export async function buildAgentContext(
  ctx: AuthContext,
  taskId: string,
): Promise<string> {
  return withUserContext(ctx.userId, async (tx) => {
    const data = await resolveDependencyClosure(tx, taskId, "agent");
    return buildAgentContextFrom(data);
  });
}
