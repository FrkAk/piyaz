import "server-only";

import { loadBundleDeps } from "@/lib/graph/effective-deps";
import {
  fetchDependencyTasks,
  fetchEdgeNotesBySource,
  fetchEdgeNotesByTarget,
  fetchTaskSummaries,
  getTaskForDepthTx,
} from "@/lib/data/task";
import { getProjectHeader } from "@/lib/data/project";
import {
  section,
  formatCriteria,
  formatDecisions,
  untrustedContentNotice,
} from "@/lib/context/format";
import type { AuthContext } from "@/lib/auth/context";
import { withUserContext } from "@/lib/db/rls";

/**
 * Extract path-like tokens from a markdown plan. A token qualifies when it
 * sits inside backticks and either contains a forward slash or matches a
 * common file-extension pattern; protocol URLs are filtered out.
 *
 * @param plan - Implementation plan markdown.
 * @returns Deduplicated set of candidate repo-relative paths.
 */
function extractPathsFromPlan(plan: string): Set<string> {
  const out = new Set<string>();
  const pattern = /`([^`\s]+)`/g;
  for (const match of plan.matchAll(pattern)) {
    const token = match[1];
    if (token.startsWith("http://") || token.startsWith("https://")) continue;
    const looksLikePath =
      token.includes("/") || /\.[a-z][a-z0-9]{0,5}$/i.test(token);
    if (!looksLikePath) continue;
    out.add(token);
  }
  return out;
}

/**
 * Build review-optimized context for an `in_review` task.
 *
 * Renders `implementationPlan` alongside `executionRecord`, surfaces the
 * PR handle from `task_links` filtered to `kind='pull_request'`, computes
 * plan-vs-files drift, lists downstream tasks whose edge notes may need a
 * refresh after merge, and emits review-lens prompt scaffolding so the
 * reviewer agent can return a structured verdict without re-deriving any
 * of the substrate. The bundle does not itself produce a verdict;
 * consumers (the `review` agent) read it.
 *
 * Status check is soft: when the task is not at `in_review` a header note
 * tells the reader the dispatch may be premature, but the bundle still
 * renders so a manual review of an in-flight task remains possible.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Formatted review context string.
 */
export async function buildReviewContext(
  ctx: AuthContext,
  taskId: string,
): Promise<string> {
  return withUserContext(ctx.userId, async (tx) => {
    const task = await getTaskForDepthTx(tx, taskId, "review");

    const [{ deps, downstream }, upstreamEdgeNotes] = await Promise.all([
      loadBundleDeps(task.projectId, taskId, 2, tx),
      fetchEdgeNotesBySource(task.projectId, taskId, tx),
    ]);

    const project = await getProjectHeader(task.projectId, tx);
    if (!project) {
      console.error("Task has no joinable project", {
        taskId: task.id,
        projectId: task.projectId,
      });
    }
    const tags = (task.tags as string[] | null) ?? [];
    const files = (task.files as string[] | null) ?? [];
    const status = task.status as string;
    const priority = task.priority as string | null;
    const estimate = task.estimate as number | null;
    const taskRef = task.taskRef;
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
    headerLines.push(`Status: \`${status}\``);
    headerLines.push(
      prLink
        ? `PR: ${prLink.url}`
        : "PR: (no `pull_request` link on task; pass the URL in dispatch or check upstream)",
    );

    const parts: string[] = [untrustedContentNotice()];

    if (status !== "in_review") {
      parts.push(
        `> **Note:** task status is \`${status}\`, not \`in_review\`. The review bundle is meant for \`in_review\` tasks; confirm the dispatch is intentional before producing a verdict.`,
      );
    }

    parts.push(headerLines.join("\n"));

    if (project) {
      const projectLines = [`Project: ${project.title}`];
      if (project.description) projectLines.push(project.description);
      parts.push(section("Project Context") + "\n" + projectLines.join("\n"));
    }

    parts.push(section("Description") + "\n" + task.description);

    parts.push(
      section("Acceptance Criteria (as evaluated by implementer)") +
        "\n" +
        formatCriteria(task.acceptanceCriteria),
    );

    parts.push(
      section("Implementation Plan (as planned)") +
        "\n" +
        (task.implementationPlan ??
          "None recorded. Plan-vs-files drift cannot be computed without a plan."),
    );

    parts.push(
      section("Execution Record (as built)") +
        "\n" +
        (task.executionRecord ??
          "None recorded. The implementer must populate this before review can proceed."),
    );

    const filesLines: string[] = [];
    if (files.length === 0) {
      filesLines.push(
        "No files recorded on task. Either the work is research / decision-only (`files=[]` is correct) or the implementer left the field unpopulated.",
      );
    } else {
      for (const f of files) filesLines.push(`- ${f}`);
    }
    parts.push(section("Files") + "\n" + filesLines.join("\n"));

    const filesSet = new Set(files);
    const planPaths = task.implementationPlan
      ? extractPathsFromPlan(task.implementationPlan)
      : new Set<string>();
    const matched: string[] = [];
    const plannedMissing: string[] = [];
    const touchedUnplanned: string[] = [];
    for (const p of planPaths) {
      if (filesSet.has(p)) matched.push(p);
      else plannedMissing.push(p);
    }
    for (const f of files) {
      if (!planPaths.has(f)) touchedUnplanned.push(f);
    }

    const driftLines: string[] = [];
    if (!task.implementationPlan) {
      driftLines.push("Skipped: no implementation plan on task.");
    } else if (planPaths.size === 0) {
      driftLines.push("Skipped: no path-like tokens extracted from plan.");
    } else {
      if (matched.length > 0) {
        driftLines.push(
          "**Planned and touched** (plan path appears in `files`):",
        );
        for (const p of matched) driftLines.push(`- ${p}`);
      }
      if (plannedMissing.length > 0) {
        driftLines.push(
          (driftLines.length > 0 ? "\n" : "") +
            "**Planned, not touched** (plan named the path, `files` does not):",
        );
        for (const p of plannedMissing) driftLines.push(`- ${p}`);
      }
      if (touchedUnplanned.length > 0) {
        driftLines.push(
          (driftLines.length > 0 ? "\n" : "") +
            "**Touched, not planned** (in `files`, no mention in plan; expect a `decisions` entry):",
        );
        for (const p of touchedUnplanned) driftLines.push(`- ${p}`);
      }
      if (driftLines.length === 0) driftLines.push("No drift detected.");
    }
    parts.push(section("Plan-vs-Files Drift") + "\n" + driftLines.join("\n"));

    if (task.decisions.length > 0) {
      parts.push(section("Decisions") + "\n" + formatDecisions(task.decisions));
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
        parts.push(section("Prerequisites") + "\n" + prereqLines.join("\n"));
      }
      if (execLines.length > 0) {
        parts.push(
          section("Upstream Execution Records") + "\n" + execLines.join("\n"),
        );
      }
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
        downLines.push(line);
      }

      if (downLines.length > 0) {
        parts.push(
          section("Downstream Impact (edges to refresh after merge)") +
            "\n" +
            downLines.join("\n"),
        );
      }
    }

    const lensPrompts = [
      "When producing the structured verdict, address each lens against the diff and the executionRecord above. Cite real file paths and line numbers; `no findings` is a valid answer.",
      "",
      "- **Security**: trust-boundary input validation, authn / authz on new endpoints, secret handling, SQL or command injection surfaces, deserialization of untrusted data.",
      "- **Performance**: N+1 query patterns, unbounded memory growth, synchronous I/O on hot paths, missing indexes implied by new query shapes.",
      "- **Reliability**: failure modes the plan listed vs the diff's handling, silent error swallowing, idempotency on retry-eligible paths, transactional boundaries.",
      "- **Observability**: logs / metrics / traces consistent with the rest of the codebase, no high-cardinality dimensions that blow the metrics backend.",
      "- **Codebase standards**: project conventions from `CLAUDE.md` and the patterns upstream executionRecord entries cite. Lint and formatting belong to the toolchain; flag substantive deviations only.",
    ];
    parts.push(section("Review Lens Prompts") + "\n" + lensPrompts.join("\n"));

    return parts.join("\n\n");
  });
}
