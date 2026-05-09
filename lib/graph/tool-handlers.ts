/**
 * Tool handlers for the 6 Mymir tools, called by the MCP server.
 * Business logic lives in lib/graph/_core/* and lib/context/_core/*;
 * handlers do validation, authorization, routing, and runtime steering
 * (token-dense fail messages and `_hints` arrays that point the agent
 * at the next correct call). The skill files under
 * `plugins/<host>/skills/mymir/` are the doctrine; this file's prose
 * is steering, not duplication.
 */

import {
  createProject,
  updateProject,
  renameProjectIdentifier,
  listProjectsForMcp,
  listUserTeams,
  getProjectTags,
  getProjectMeta,
} from "@/lib/data/project";
import {
  createTask,
  updateTask,
  deleteTask,
  deleteTaskPreview,
  searchTasks,
  getProjectTasksSlim,
} from "@/lib/data/task";
import {
  createEdge,
  updateEdge,
  removeEdge,
  getTaskEdgesDetailed,
  findEdgeByNodes,
} from "@/lib/data/edge";
import type { TaskState } from "@/lib/data/task";
import { buildProjectOverview } from "@/lib/context/_core/overview";
import { buildSummaryContext } from "@/lib/context/_core/summary";
import {
  buildWorkingContext,
  formatWorkingContext,
} from "@/lib/context/_core/working";
import { buildAgentContext } from "@/lib/context/_core/agent";
import { buildPlanningContext } from "@/lib/context/_core/planning";
import {
  getReadyTasks,
  getBlockedTasks,
  getDownstream,
  getCriticalPath,
  getPlannableTasks,
} from "@/lib/data/traversal";
import type { EdgeType, Decision } from "@/lib/types";
import { parseIdentifier } from "@/lib/graph/identifier";
import type { ProjectUpdate } from "@/lib/data/project";
import type { TaskUpdate } from "@/lib/data/task";
import type { Project } from "@/lib/db/schema";
import {
  MultiTeamAmbiguityError,
  NoTeamMembershipError,
} from "@/lib/graph/errors";
import {
  formatSummary,
  formatSearchResults,
  formatTaskList,
  formatDetailedEdges,
  formatOverview,
  formatProjectMeta,
  formatReadyTasks,
  formatBlockedTasks,
  formatDownstream,
  formatCriticalPath,
  formatPlannableTasks,
} from "./format-responses";
import {
  PRIORITY_TAGS,
  WORK_TYPE_TAGS,
  findVariant,
  normalizeTags,
} from "./tag-similarity";
import type { AuthContext } from "@/lib/auth/context";
import {
  ForbiddenError,
  InsufficientRoleError,
  assertTaskAccess,
} from "@/lib/auth/authorization";

/**
 * Build variant-warning hints for proposed tags against existing project tags.
 * @param proposed - Proposed tag strings.
 * @param existing - Current project tag list.
 * @returns Hint strings for tags that look like variants of existing ones.
 */
function tagVariantHints(proposed: string[], existing: string[]): string[] {
  const hints: string[] = [];
  for (const tag of proposed) {
    const variant = findVariant(tag, existing);
    if (variant)
      hints.push(
        `Tag "${tag}" looks like a variant of existing "${variant}". Reuse the existing tag, or confirm a deliberate split.`,
      );
  }
  return hints;
}

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Build hints for tag-taxonomy violations. Kebab-case is structural and
 * universal. The work-type and priority dimension checks are heuristic:
 * the server matches against the canonical English closed vocabulary
 * documented in `references/artifacts.md` §2, but Mymir runs across
 * projects authored in any language. When the canonical match misses,
 * the hint refers the agent to the reference rather than enumerating
 * English values inline, so localized tag sets are not penalized.
 *
 * Open-vocabulary dimensions (cross-cutting concern, tech) cannot be
 * checked server-side without false positives and are left to agent
 * discipline.
 *
 * @param tags - Proposed tag list (already normalized for whitespace).
 * @returns Hint strings; empty array when the tag set passes all checks.
 */
function tagTaxonomyHints(tags: string[]): string[] {
  const hints: string[] = [];
  const malformed = tags.filter((t) => !KEBAB_CASE_RE.test(t));
  if (malformed.length > 0) {
    hints.push(
      `Tags must be kebab-case (lowercase, digits, hyphens). Re-tag: ${malformed
        .map((t) => `"${t}"`)
        .join(", ")}.`,
    );
  }
  const lowered = tags.map((t) => t.toLowerCase());
  const missing: string[] = [];
  if (!lowered.some((t) => WORK_TYPE_TAGS.has(t))) missing.push("work-type");
  if (!lowered.some((t) => PRIORITY_TAGS.has(t))) missing.push("priority");
  if (missing.length > 0) {
    hints.push(
      `Could not detect ${missing.join(" + ")} dimension tag${
        missing.length > 1 ? "s" : ""
      } from the canonical vocabulary. Every task carries all four dimensions (work-type, cross-cutting concern, tech, priority); see artifacts §2 for the canonical closed-vocabulary terms. Projects authored in other languages may use equivalent localized tags — in that case this hint is heuristic, verify the dimensions are present in your project's idiom and ignore.`,
    );
  }
  return hints;
}

/**
 * Hint when description is a single sentence. Per `references/artifacts.md`
 * §1: "Single-sentence descriptions are rejected." No upper bound: the
 * skill rule is "no fluff, not no length"; length policing is left to
 * agent discipline.
 *
 * Sentence counting strips backtick code spans first so file paths and
 * version numbers inside code syntax don't pad the count.
 *
 * @param description - Proposed description string.
 * @returns Hints; empty when description is multi-sentence or absent.
 */
function descriptionSizeHints(description: string | undefined): string[] {
  if (!description) return [];
  const trimmed = description.trim();
  if (!trimmed) return [];
  const stripped = trimmed.replace(/`[^`]*`/g, " ");
  const terminators = stripped.match(/[.!?](?:\s|$)/g)?.length ?? 0;
  if (terminators <= 1) {
    return [
      "Description is a single sentence. Single-sentence descriptions are rejected (artifacts §1). Expand to 2-4 sentences covering what + why + how it fits, up to 6-8 for genuinely complex tasks.",
    ];
  }
  return [];
}

/**
 * Hints for acceptance-criteria size drift. Per `references/artifacts.md`
 * §1: 2-4 binary items. Single-AC tasks are rejected; >4 usually means
 * the task is two tasks. Both surface the band rule; only the agent can
 * judge whether a particular task is the legitimate exception.
 *
 * @param criteria - Proposed acceptance-criteria array.
 * @returns Hints; empty when count is in band or array is absent.
 */
function acQualityHints(criteria: unknown[] | undefined): string[] {
  if (!Array.isArray(criteria)) return [];
  const hints: string[] = [];
  if (criteria.length === 1) {
    hints.push(
      "Single-AC tasks are rejected (artifacts §1). 2-4 binary items is the band. A one-AC list is usually under-scoped or a vague catch-all; split it.",
    );
  } else if (criteria.length > 4) {
    hints.push(
      `acceptanceCriteria has ${criteria.length} items. The 2-4 band is deliberate (artifacts §1); past 4, the task is usually two tasks. Consider splitting.`,
    );
  }
  return hints;
}

/**
 * Hint when status='draft' carries fields lifecycle §1 forbids.
 * `executionRecord` implies the task shipped; `implementationPlan` is the
 * artifact that transitions draft → planned, so writing it without the
 * status change leaves the task in an incomplete state.
 *
 * @param status - Proposed status (skip when not draft).
 * @param payload - Fields from this request.
 * @returns Hints; empty when status is not draft or fields are absent.
 */
function draftFieldHints(
  status: string | undefined,
  payload: { executionRecord?: string; implementationPlan?: string },
): string[] {
  if (status !== "draft") return [];
  const hints: string[] = [];
  if (payload.executionRecord) {
    hints.push(
      "Draft tasks must not carry executionRecord (lifecycle §1). That field implies the task shipped. If the work is done, set status='done' and follow the Completion Protocol; if you're capturing a plan, use implementationPlan with status='planned'.",
    );
  }
  if (payload.implementationPlan) {
    hints.push(
      "implementationPlan with status='draft' is incomplete (lifecycle §1). Saving an unabridged plan transitions the task to planned; pass implementationPlan together with status='planned'.",
    );
  }
  return hints;
}

/**
 * Build a hint when a status transition skips intermediate states
 * (e.g. draft → done, draft → in_progress, planned → done). The lifecycle
 * is `draft → planned → in_progress → done`; cancelled is reachable from
 * any non-terminal and is handled by `terminalReversalHints`.
 *
 * @param priorStatus - The task's status before the update.
 * @param nextStatus - The status the caller is transitioning to.
 * @returns Hint strings; empty when the transition is monotonic.
 */
function statusJumpHints(priorStatus: string, nextStatus: string): string[] {
  const order = ["draft", "planned", "in_progress", "done"];
  const priorIdx = order.indexOf(priorStatus);
  const nextIdx = order.indexOf(nextStatus);
  if (priorIdx === -1 || nextIdx === -1) return [];
  if (nextIdx > priorIdx + 1) {
    const skipped = order.slice(priorIdx + 1, nextIdx).join(" → ");
    return [
      `Status jumped ${priorStatus} → ${nextStatus}, skipping ${skipped} (lifecycle §1). If this is an intentional back-fill of completed work, ensure implementationPlan and executionRecord both reflect what shipped; otherwise transition through the missing states.`,
    ];
  }
  return [];
}

/**
 * Build hints when `overwriteArrays=true` shrinks an array field. The
 * server has no undo for the overwritten content; the only recovery is
 * reading the prior values from the task's `history` entries. Per
 * `references/resilience.md` §9, `overwriteArrays` is agent-discipline:
 * this hint surfaces silent destructive ops the agent might not have
 * realized happened.
 *
 * @param payload - Array fields supplied by the caller (post-cast).
 * @param prior - Prior values from the row before the update.
 * @returns One hint per shrunk field.
 */
function overwriteShrinkHints(
  payload: {
    acceptanceCriteria?: unknown[];
    decisions?: unknown[];
    files?: string[];
  },
  prior: {
    acceptanceCriteria?: unknown[] | null;
    decisions?: unknown[] | null;
    files?: string[] | null;
  },
): string[] {
  const hints: string[] = [];
  const check = (
    name: string,
    next?: unknown[],
    before?: unknown[] | null,
  ): void => {
    if (!next || !before) return;
    if (next.length < before.length) {
      hints.push(
        `overwriteArrays=true replaced ${name} (${before.length} → ${next.length}, ${
          before.length - next.length
        } lost). The lost entries cannot be recovered — the task history is an audit log of which fields changed, not a snapshot of prior values. Confirm with the user before continuing.`,
      );
    }
  };
  check("acceptanceCriteria", payload.acceptanceCriteria, prior.acceptanceCriteria);
  check("decisions", payload.decisions, prior.decisions);
  check("files", payload.files, prior.files);
  return hints;
}

/**
 * Build warning hints for semantically incoherent terminal-to-terminal
 * status transitions.
 * @param priorStatus - The task's status before the update.
 * @param nextStatus - The status the caller is transitioning to.
 * @returns Hint strings (empty when the transition is normal).
 */
function terminalReversalHints(
  priorStatus: string,
  nextStatus: string,
): string[] {
  if (priorStatus === "done" && nextStatus === "cancelled") {
    return [
      "Transitioning done → cancelled is unusual: it removes this task from the progress numerator and drops the percentage. If the work shipped but is now obsolete, prefer keeping it done and creating a follow-up cancelled task with the rationale, so the historical credit is preserved.",
    ];
  }
  if (priorStatus === "cancelled" && nextStatus === "done") {
    return [
      "Transitioning cancelled → done skips the work pipeline. If the work was actually completed, prefer cancelled → in_progress → done so executionRecord captures what was built rather than the cancellation rationale.",
    ];
  }
  return [];
}

/**
 * Build hints when a task is cancelled. Required-field hints fire first
 * (rationale + decisions per lifecycle §1); the propagation hint is
 * informational and lifecycle §3 rules apply.
 * @param payload - Fields supplied by the caller in this request.
 * @param persisted - Row state after the mutation.
 * @returns Hint strings for missing rationale and downstream propagation.
 */
function cancelledStatusHints(
  payload: {
    executionRecord?: string;
    decisions?: Decision[];
  },
  persisted: {
    executionRecord?: string | null;
    decisions?: Decision[] | null;
  },
): string[] {
  const hints: string[] = [];
  if (!payload.executionRecord && !persisted.executionRecord) {
    hints.push(
      "Missing cancellation rationale (lifecycle §1). Add it to executionRecord: why abandoned + what approaches were tried, so downstream tasks (and future revisits) understand the decision.",
    );
  }
  if (!payload.decisions && (!persisted.decisions || persisted.decisions.length === 0)) {
    hints.push(
      "Missing decisions. Record technical choices made before cancelling (CHOICE + WHY); preserves what was learned for any future revisit.",
    );
  }
  hints.push(
    "Cancellation is transparent in the dep graph: dependents stay blocked through this task's own unsatisfied prereqs (lifecycle §3). Run mymir_analyze type='downstream' and decide deliberately: is there a replacement task? If yes, rewire dependents to it. If not, dependents may need cancelling or re-scoping. Do not decide silently.",
  );
  return hints;
}

/**
 * Build completion-protocol hints when a task transitions to or is created
 * in the `done` state. Required-field hints come first (executionRecord,
 * decisions, files, AC evaluation per lifecycle §1); the PR-opening hint
 * fires when the work touched files (lifecycle §2 step 3); the
 * propagation hint is informational (lifecycle §3).
 * @param payload - Fields supplied by the caller in this request.
 * @param persisted - Row state after the mutation.
 * @returns Hint strings for missing execution metadata, PR-opening, and
 *   downstream propagation.
 */
function doneStatusHints(
  payload: {
    executionRecord?: string;
    decisions?: Decision[];
    files?: string[];
  },
  persisted: {
    executionRecord?: string | null;
    decisions?: Decision[] | null;
    files?: string[] | null;
    acceptanceCriteria?: { checked: boolean }[] | null;
  },
): string[] {
  const hints: string[] = [];
  if (!payload.executionRecord && !persisted.executionRecord) {
    hints.push(
      "Missing executionRecord (lifecycle §1). Add 3-5 sentences on HOW it was built: function names, file paths, endpoints. Distinct from description (scope). Downstream tasks depend on this for context.",
    );
  }
  if (!payload.decisions && (!persisted.decisions || persisted.decisions.length === 0)) {
    hints.push(
      "Missing decisions (lifecycle §1). Record technical choices (CHOICE + WHY); downstream tasks need them.",
    );
  }
  if (!payload.files && (!persisted.files || persisted.files.length === 0)) {
    hints.push(
      "Missing files (lifecycle §1). Record every path created or modified. For pure spec-review / docs / decision-only tasks that touched no repo files, pass files=[] explicitly so this hint clears.",
    );
  }
  const criteria = persisted.acceptanceCriteria;
  if (
    persisted.executionRecord &&
    criteria &&
    criteria.length > 0 &&
    criteria.every((c) => !c.checked)
  ) {
    hints.push(
      "Acceptance criteria are all unchecked. Evaluate each against your executionRecord and re-submit with acceptanceCriteria=[{text, checked: true|false}, ...]. Do not auto-check everything.",
    );
  }
  const persistedFiles = payload.files ?? persisted.files ?? [];
  if (persistedFiles.length > 0) {
    hints.push(
      "Code change shipped. Open a PR per Completion Protocol (lifecycle §2 step 3): detect a template (.github/PULL_REQUEST_TEMPLATE.md and variants); fill it concisely from executionRecord and ACs; use [taskRef] bracket form for the ONE primary task this PR builds (triggers Mymir PR-status tracking). Skip for research / decision-only / Mymir-only refinements.",
    );
  }
  hints.push(
    "Run mymir_analyze type='downstream' to propagate (lifecycle §3): update edge notes, retire stale edges, surface new dependencies revealed by this completion.",
  );
  return hints;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Discriminated result from a tool handler. */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/** @returns Success result wrapping data. */
function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

/** @returns Failure result with actionable message. */
function fail(msg: string): ToolResult {
  return { ok: false, error: msg };
}

/**
 * Per-state next-call hints fired on a single search hit. Every actionable
 * state opens with a confirmation gate: the agent recommends, the user (or
 * leader agent in dispatched mode) decides. Auto-claiming a ready task,
 * auto-promoting a draft, or auto-taking-over an in_progress is forbidden.
 * The gate matches the skill's "recommend → user picks → act" workflow
 * and the Completion Protocol's mode-detection rule (lifecycle §2).
 *
 * Read-only states (`done`, `cancelled`) skip the upfront gate but still
 * defer the next-task decision to the user/leader after propagation.
 * `blocked` is informational; nothing to claim.
 */
const STATE_HINTS: Record<TaskState, string> = {
  plannable:
    "Plannable. Recommend this task to the user (direct mode) or return to the orchestrator (dispatched mode); wait for explicit pick before acting. After confirmation: write the implementation plan, then status='planned'. Fetch depth='planning' (project description, upstream executionRecords, downstream specs). Before writing: search the codebase for what already exists, read current docs for any new dependency, reason through edge cases. No speculation. Save the unabridged plan; do not summarize.",
  ready:
    "Ready. Recommend this task to the user (direct mode) or return to the orchestrator (dispatched mode); wait for explicit pick before claiming. After confirmation: status='in_progress' to claim, then fetch depth='agent' (multi-hop deps, upstream executionRecords, files, downstream specs); read the relevant code; refer to current docs; reason through edge cases. Understand before doing.",
  blocked:
    "Blocked. Cannot advance until upstream deps complete. Run mymir_analyze type='blocked' for blocker details, or fetch depth='summary' for this task's edges. Surface the choices to the user/leader: pick a different ready task, or unblock by completing a dep. Do not pick silently.",
  in_progress:
    "Claimed (one worker per task; lifecycle §1). Take-over is not automatic: confirm with the user (direct mode) or orchestrator (dispatched mode) that the prior worker has gone away before resuming. After confirmation: fetch depth='agent', read prior notes plus upstream executionRecords. To finish: populate executionRecord, decisions, files, evaluate every AC (do not auto-check), open a PR if files changed, then follow the Completion Protocol (lifecycle §2).",
  done: "Terminal. Fetch depth='agent' for the full executionRecord, decisions, and files (depth='working' renders ACs/decisions/edges but not executionRecord or files; depth='summary' is just the header + edges). Then mymir_analyze type='downstream' to propagate decisions onto dependents (edge notes, descriptions, new edges, stale edges). After propagation, ask the user/leader what's next; do not auto-proceed to another task.",
  cancelled:
    "Terminal (abandoned). Fetch depth='agent' for the cancellation rationale (lives in executionRecord) and decisions; depth='working' renders decisions but not the rationale. Edges remain in place; cancellation is transparent (dependents stay blocked through this task's own unsatisfied deps; lifecycle §3). Ask the user/leader: is there a replacement? If yes, rewire dependents to it. If not, dependents may need cancelling or re-scoping. Do not decide silently.",
  draft:
    "Draft. Not ready to plan. Recommend refinement to the user (direct mode) or orchestrator (dispatched mode); wait for confirmation before editing. After confirmation: fetch depth='working' and tighten description to 2-4 sentences with 2-4 binary acceptance criteria. Before refining, explore: search related tasks, read current docs, check the codebase. Push back on vagueness; rewrite single-sentence descriptions and 'works correctly' ACs. Once description and ACs are present, the task becomes plannable.",
};

/**
 * Get a context-depth hint for a task's derived state.
 * @param state - The derived TaskState.
 * @returns Hint string telling the agent which context depth to fetch.
 */
function stateHint(state: TaskState): string {
  return STATE_HINTS[state];
}

// ---------------------------------------------------------------------------
// Error translation — data-layer asserts throw, this maps to actionable hints
// ---------------------------------------------------------------------------

/**
 * Detect a Postgres unique-constraint violation on a thrown driver error.
 *
 * postgres-js attaches the SQLSTATE on `code`; `23505` is unique-violation.
 * Used to map otherwise-leaky driver errors to a clean conflict message
 * before they reach the catch-all that would otherwise echo the raw query.
 *
 * @param e - Caught error.
 * @returns True when `e` carries `code === "23505"`.
 */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: unknown }).code === "23505"
  );
}

/**
 * Translate a thrown error to a token-dense, agent-correcting tool failure.
 *
 * Each branch carries a recovery path the agent can execute on its own:
 * - InsufficientRole: name the action that requires admin so the agent can
 *   tell the user (or the orchestrator) to escalate.
 * - Forbidden: 404-shaped per resource, with the next-tool to call.
 * - MultiTeamAmbiguity: include the team list inline so the agent can
 *   present choices to the user without an extra round trip.
 * - NoTeamMembership: send the user to the web app to create or join.
 * - Postgres unique-violation: clean conflict message; never leak the
 *   raw query, parameter values, or column list to the client.
 *
 * Anything else falls through to the opaque catch-all: logged server-side
 * with full context, returned to the client as `Internal error`. Verbose
 * `err.message` forwarding is whitelist-gated to `NODE_ENV === "development"`
 * (i.e. `bun run dev`); every other env value falls through to generic so
 * a silent env change can't start leaking driver internals.
 *
 * The data-layer assertions tag ForbiddenError with `resource`/`resourceId`,
 * so this layer never re-queries the database.
 *
 * @param e - Caught error.
 */
function translateError(e: unknown): ToolResult {
  if (e instanceof InsufficientRoleError) {
    return fail(
      `Forbidden: only team admins can ${e.primaryAction} projects. Tell the user; they need a team admin to do this.`,
    );
  }
  if (e instanceof MultiTeamAmbiguityError) {
    const list = e.teams.map((t) => `${t.name} (${t.id})`).join(", ");
    return fail(
      `organizationId required: multi-team account. Teams: ${list}. Ask the user which team, then retry with organizationId='<uuid>'. mymir_project action='teams' returns the same list anytime, with role + projectCount.`,
    );
  }
  if (e instanceof NoTeamMembershipError) {
    return fail(
      "No team membership: the caller does not belong to any team. Ask the user to sign in to the web app and create or join a team, then retry.",
    );
  }
  if (e instanceof ForbiddenError) {
    const id = e.resourceId ?? "";
    switch (e.resource) {
      case "project":
        return fail(
          `Project '${id}' not found in any team you belong to. Run mymir_project action='list' to see available projects across all your teams.`,
        );
      case "task":
        return fail(
          `Task '${id}' not found in any team you belong to. Run mymir_query type='search' with a projectId, or type='list' to enumerate tasks.`,
        );
      case "edge":
        return fail(
          `Edge '${id}' not found. Run mymir_query type='edges' with a taskId to see current edges on that task.`,
        );
      case "team":
        return fail(
          `organizationId '${id}' is not a team you belong to. Run mymir_project action='teams' to see valid ids, then ask the user which team before retrying.`,
        );
      default:
        return fail(
          "Not found in any team you belong to. Run mymir_project action='list' to see what you can access.",
        );
    }
  }
  if (isUniqueViolation(e)) {
    const constraint =
      (e as { constraint_name?: string }).constraint_name ?? "";
    if (constraint.includes("identifier")) {
      return fail(
        "Project identifier already in use in this team. Pick a different one (2-12 chars, uppercase alphanumeric).",
      );
    }
    return fail("Conflict: a record with that value already exists.");
  }
  console.error("[graph:tool-handlers] unhandled error:", e);
  const verbose = process.env.NODE_ENV === "development";
  return fail(verbose && e instanceof Error ? e.message : "Internal error");
}

// ---------------------------------------------------------------------------
// Shared descriptions (MCP tools are ground truth)
//
// Tool descriptions are loaded on every agent turn — every word is paid
// N×turns. Each line below earns its place: purpose, per-action steering,
// a critical limitation or rule, the next-call cue. Doctrine (tag
// taxonomy, AC quality, category vocab, full lifecycle table, persona)
// lives in the skill's reference files; the server steers the agent
// toward the right rule rather than restating it.
// ---------------------------------------------------------------------------

/** Tool descriptions shared between MCP and web app. */
export const DESCRIPTIONS = {
  mymir_project:
    "List, create, and update projects, plus enumerate team memberships. Spans every team the caller belongs to; no server-side session state, so pass projectId explicitly on every downstream call. " +
    "list=projects (id, title, identifier, status, team chip, task counts, progress); skips empty teams; description and tag vocab fetched on demand via mymir_query type='meta'. " +
    "teams=every membership (id, name, slug, role, projectCount); call before create or when list misses a team. " +
    "select=confirm working project; pass returned projectId on every subsequent call. " +
    "create=new project; multi-team accounts MUST pass organizationId (server rejects ambiguous calls with the team list inline; auto-resolves single-team). " +
    "update=title, description, status, categories, or identifier. Renaming identifier cascades every taskRef and breaks external references (PR titles, docs, commits).",
  mymir_task:
    "Create, update, or delete tasks. Lifecycle: draft → planned → in_progress → done. cancelled is terminal abandoned work with transparent dep semantics (dependents stay blocked through the cancelled task's own unsatisfied prereqs; populate executionRecord with rationale). " +
    "create requires title (verb+noun, imperative), description (2-4 sentences; single-sentence rejected), 2-4 binary acceptanceCriteria, all four tag dimensions (work-type, cross-cutting, tech, priority), one project category. " +
    "update: pass only changed fields. Array fields (acceptanceCriteria, decisions, files) APPEND by default; overwriteArrays=true REPLACES them. Destructive, NO undo (history is an audit log); confirm with user first. " +
    "delete: preview=true (default) shows impact; preview=false executes. Prefer status='cancelled' for abandoned scope so the rationale is preserved. " +
    "Done means: executionRecord (3-5 sentences, what was built), decisions (CHOICE+WHY), files (every path), acceptanceCriteria evaluated. Open a PR if files non-empty; run mymir_analyze type='downstream' to propagate.",
  mymir_edge:
    "Create, update, or remove dependency edges between tasks. depends_on=source needs target's output (target must be done first). relates_to=informational link, neither blocks the other. Litmus test: removing the target makes the source impossible → depends_on; just makes it harder → relates_to. " +
    "create: edge note REQUIRED and substantive; notes propagate to downstream agent context, and placeholders ('needed', 'depends') are rejected. Write it as a brief to the developer about to start the source task. " +
    "update: change edgeType or note by edgeId. " +
    "remove: by edgeId OR by sourceTaskId+targetTaskId+edgeType. " +
    "Server rejects self-edges, duplicates, and cycles. On 'duplicate edge' (concurrent-write race): treat as success and verify with mymir_query type='edges'.",
  mymir_query:
    "Search and browse project data. Pick the slim tool first; reserve overview for unfamiliar projects. " +
    "search=tasks by taskRef, title, or tag substring (case-insensitive, up to 20). Pass tags=[...] for exact tag match (OR-within); combine with `query` to AND-narrow. Single-result responses include a state hint pointing to the right next call. " +
    "list=every task in the project (slim, ordered by position). " +
    "edges=relationships on one task (connected title, status, direction, note). " +
    "meta=slim project metadata: header, description, status, categories, tag vocabulary (with usage counts), progress + status counts. No task list, no edges. Use this to look up categories before setting one, or the tag vocabulary before coining new tags. " +
    "overview=full project structure: every task, every edge, full tag vocab, progress. VERY HEAVY. Reserve for unfamiliar-project orientation, decompose's pre-write coverage check, or strategic review. At most once per session. For just categories or tag vocab, use meta.",
  mymir_context:
    "Retrieve task context at varying depth. ALWAYS fetch context before reasoning about a task; pick the lightest depth that answers the question. " +
    "summary=task header + description + counts (criteria, decisions, plan flag, edge counts) + full 1-hop edges WITH notes. The lightest depth that still carries edge notes; folds in what `mymir_query type='edges'` would give. " +
    "working=detailed (criteria, decisions, 1-hop edges, siblings) for refinement and review. " +
    "agent=multi-hop dependency chains with upstream execution records (~4-8K tokens); fetch BEFORE coding. " +
    "planning=spec-focused (project description, prereqs, acceptance criteria, downstream specs); fetch BEFORE writing the implementation plan.",
  mymir_analyze:
    "Analyze the project dependency graph. All variants slim; lead with these for status, prioritization, 'what's next', 'what's stuck'. " +
    "critical_path=longest dep chain (project bottleneck, minimum duration). Lead with this on continue / resume / 'guide me forward'; the most important type for prioritization. " +
    "ready=planned tasks with all effective deps done (only `status='planned'` reaches this state; drafts with satisfied deps surface as `plannable`, not `ready`). Pick from `ready ∩ critical_path` for the highest-impact unblocked work. " +
    "plannable=draft tasks with description + criteria, ready for planning. Fall back here when nothing is ready to code. " +
    "blocked=tasks waiting on unfinished deps with blocker details. " +
    "downstream=transitive dependents of one task; impact analysis before status change, refinement, or cancellation.",
} as const;

// ---------------------------------------------------------------------------
// Param types
// ---------------------------------------------------------------------------

/** Params for mymir_project (handler covers list/create/update/teams; MCP handles select separately). */
export type ProjectParams = {
  action: "list" | "create" | "update" | "teams";
  projectId?: string;
  title?: string;
  description?: string;
  status?: "brainstorming" | "decomposing" | "active" | "archived";
  categories?: string[];
  identifier?: string;
  /**
   * Target team UUID for `create`. Required when the caller is a member
   * of more than one team. Membership in the supplied team is enforced
   * server-side; cross-team probes return a 404-shaped 'not found'.
   */
  organizationId?: string;
};

/** Params for mymir_task. */
export type TaskParams = {
  action: "create" | "update" | "delete";
  projectId?: string;
  taskId?: string;
  title?: string;
  description?: string;
  status?: "draft" | "planned" | "in_progress" | "done" | "cancelled";
  acceptanceCriteria?: unknown[];
  decisions?: unknown[];
  tags?: string[];
  category?: string;
  files?: string[];
  implementationPlan?: string;
  executionRecord?: string;
  preview?: boolean;
  overwriteArrays?: boolean;
};

/** Params for mymir_edge. */
export type EdgeParams = {
  action: "create" | "update" | "remove";
  edgeId?: string;
  sourceTaskId?: string;
  targetTaskId?: string;
  edgeType?: "depends_on" | "relates_to";
  note?: string;
};

/** Params for mymir_query. */
export type QueryParams = {
  type: "search" | "list" | "edges" | "meta" | "overview";
  projectId?: string;
  query?: string;
  tags?: string[];
  taskId?: string;
};

/** Params for mymir_context. */
export type ContextParams = {
  taskId: string;
  depth: "summary" | "working" | "agent" | "planning";
  projectId?: string;
};

/** Params for mymir_analyze. */
export type AnalyzeParams = {
  type: "ready" | "blocked" | "downstream" | "critical_path" | "plannable";
  projectId?: string;
  taskId?: string;
};

// ---------------------------------------------------------------------------
// Handlers — all take ctx as the second arg
// ---------------------------------------------------------------------------

/**
 * Handle mymir_project actions (list/create/update).
 * @param p - Validated project params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with project data.
 */
export async function handleProject(
  p: ProjectParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.action) {
      case "list":
        return ok(await listProjectsForMcp(ctx));
      case "teams":
        return ok(await listUserTeams(ctx));
      case "create": {
        if (!p.title)
          return fail(
            "title required for create. 2-5 words, verb-noun preferred (e.g. 'Track team habits').",
          );
        let parsedIdentifier;
        if (p.identifier !== undefined) {
          const parsed = parseIdentifier(p.identifier);
          if (!parsed.ok) return fail(parsed.error);
          parsedIdentifier = parsed.value;
        }
        const project = await createProject(ctx, {
          title: p.title,
          description: p.description ?? "",
          ...(p.status !== undefined && { status: p.status }),
          categories: p.categories,
          identifier: parsedIdentifier,
          organizationId: p.organizationId,
        });
        const createHints: string[] = [];
        if (p.identifier === undefined) {
          createHints.push(
            `Auto-derived identifier '${project.identifier}' from title. Pass identifier='...' to override (2-12 chars, uppercase alphanumeric, unique per team).`,
          );
        }
        return ok(createHints.length > 0 ? { ...project, _hints: createHints } : project);
      }
      case "update": {
        if (!p.projectId) return fail("projectId required for update. Run mymir_project action='list' to find it.");
        if (
          p.title === undefined &&
          p.description === undefined &&
          p.status === undefined &&
          p.categories === undefined &&
          p.identifier === undefined
        ) {
          return fail(
            "update requires at least one of: title, description, status, categories, identifier.",
          );
        }
        const changes: ProjectUpdate = {};
        if (p.title !== undefined) changes.title = p.title;
        if (p.description !== undefined) changes.description = p.description;
        if (p.status !== undefined) changes.status = p.status;
        if (p.categories !== undefined) changes.categories = p.categories;

        let project: Project | undefined;
        if (p.identifier !== undefined) {
          const parsed = parseIdentifier(p.identifier);
          if (!parsed.ok) return fail(parsed.error);
          project = await renameProjectIdentifier(ctx, p.projectId, parsed.value);
        }
        if (Object.keys(changes).length > 0) {
          project = await updateProject(ctx, p.projectId, changes);
        }

        const updateHints: string[] = [];
        if (p.identifier !== undefined) {
          updateHints.push(
            `Renamed all task refs to '${p.identifier}-N'. External references (GitHub PRs, docs, commit messages) to the old prefix no longer resolve.`,
          );
        }
        return ok(
          updateHints.length > 0
            ? { ...project, _hints: updateHints }
            : project,
        );
      }
    }
  } catch (e) {
    return translateError(e);
  }
}

/**
 * Handle mymir_task actions.
 * @param p - Validated task params. projectId required for create.
 * @param ctx - Resolved auth context.
 * @returns Tool result with task data.
 */
export async function handleTask(
  p: TaskParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.action) {
      case "create": {
        if (!p.projectId)
          return fail("projectId required for create. Run mymir_project action='list' or 'select' first.");
        if (!p.title)
          return fail(
            "title required for create. Verb+noun, imperative (e.g. 'Implement JWT auth', not 'Auth'). Artifacts §1.",
          );
        if (!p.description)
          return fail(
            "description required for create. 2-4 sentences covering what + why + how it fits; up to 6-8 for genuinely complex tasks. Single-sentence descriptions are rejected. Artifacts §1.",
          );
        const preExistingTags =
          p.tags && p.tags.length > 0
            ? (await getProjectTags(ctx, p.projectId)).map((t) => t.tag)
            : [];
        const task = await createTask(ctx, {
          projectId: p.projectId,
          title: p.title,
          description: p.description,
          status: p.status,
          acceptanceCriteria: (p.acceptanceCriteria ?? []) as unknown as {
            id: string;
            text: string;
            checked: boolean;
          }[],
          tags: p.tags,
          category: p.category,
          files: p.files,
          implementationPlan: p.implementationPlan,
          executionRecord: p.executionRecord,
          decisions: p.decisions as unknown as Decision[],
        });
        const createHints: string[] = [];
        // Required-field-shaped hints first (artifact-quality violations on input)
        if (p.tags && p.tags.length > 0) {
          createHints.push(...tagVariantHints(p.tags, preExistingTags));
          createHints.push(...tagTaxonomyHints(p.tags));
        }
        createHints.push(...descriptionSizeHints(p.description));
        createHints.push(...acQualityHints(p.acceptanceCriteria));
        createHints.push(
          ...draftFieldHints(p.status ?? "draft", {
            executionRecord: p.executionRecord,
            implementationPlan: p.implementationPlan,
          }),
        );
        // Status-driven completion-protocol hints
        if (p.status === "done") {
          const persisted = await assertTaskAccess(task.id, ctx);
          if (persisted) {
            createHints.push(
              ...doneStatusHints(
                {
                  executionRecord: p.executionRecord,
                  decisions: p.decisions as Decision[] | undefined,
                  files: p.files,
                },
                {
                  executionRecord: persisted.executionRecord,
                  decisions: persisted.decisions as Decision[] | null,
                  files: persisted.files,
                  acceptanceCriteria:
                    persisted.acceptanceCriteria as { checked: boolean }[] | null,
                },
              ),
            );
          }
        }
        if (p.status === "cancelled") {
          const persisted = await assertTaskAccess(task.id, ctx);
          if (persisted) {
            createHints.push(
              ...cancelledStatusHints(
                {
                  executionRecord: p.executionRecord,
                  decisions: p.decisions as Decision[] | undefined,
                },
                {
                  executionRecord: persisted.executionRecord,
                  decisions: persisted.decisions as Decision[] | null,
                },
              ),
            );
          }
        }
        // Informational follow-ups
        if (!p.acceptanceCriteria || p.acceptanceCriteria.length === 0) {
          createHints.push(
            "No acceptance criteria. Add 2-4 binary done-conditions with mymir_task action='update'. Artifacts §1.",
          );
        }
        if (!p.category) {
          createHints.push(
            "No category. Run mymir_query type='meta' to see this project's categories, then set one with mymir_task action='update'.",
          );
        }
        createHints.push("No edges yet. Add dependencies with mymir_edge action='create'.");
        return ok({ ...task, _hints: createHints });
      }
      case "update": {
        if (!p.taskId)
          return fail(
            "taskId required for update. Use mymir_query type='search' to find it.",
          );
        if (
          p.title === undefined &&
          p.description === undefined &&
          p.status === undefined &&
          p.acceptanceCriteria === undefined &&
          p.decisions === undefined &&
          p.tags === undefined &&
          p.category === undefined &&
          p.files === undefined &&
          p.implementationPlan === undefined &&
          p.executionRecord === undefined
        ) {
          return fail(
            "update requires at least one of: title, description, status, acceptanceCriteria, decisions, tags, category, files, implementationPlan, executionRecord.",
          );
        }
        let preExistingTags: string[] = [];
        let priorStatus: string | undefined;
        let priorAcceptanceCriteria: unknown[] | null | undefined;
        let priorDecisions: unknown[] | null | undefined;
        let priorFiles: string[] | null | undefined;
        const willOverwriteShrinkable =
          !!p.overwriteArrays &&
          (p.acceptanceCriteria !== undefined ||
            p.decisions !== undefined ||
            p.files !== undefined);
        const needsExisting =
          (p.tags !== undefined && p.tags.length > 0) ||
          p.status !== undefined ||
          willOverwriteShrinkable;
        if (needsExisting) {
          const existing = await assertTaskAccess(p.taskId, ctx);
          if (existing) {
            if (p.tags && p.tags.length > 0) {
              preExistingTags = (
                await getProjectTags(ctx, existing.projectId)
              ).map((t) => t.tag);
            }
            priorStatus = existing.status;
            priorAcceptanceCriteria = existing.acceptanceCriteria as unknown[] | null;
            priorDecisions = existing.decisions as unknown[] | null;
            priorFiles = existing.files as string[] | null;
          }
        }
        const changes: TaskUpdate = {};
        if (p.title !== undefined) changes.title = p.title;
        if (p.description !== undefined) changes.description = p.description;
        if (p.status !== undefined) changes.status = p.status;
        if (p.acceptanceCriteria !== undefined)
          changes.acceptanceCriteria = p.acceptanceCriteria;
        if (p.decisions !== undefined) changes.decisions = p.decisions;
        if (p.tags !== undefined) changes.tags = p.tags;
        if (p.category !== undefined) changes.category = p.category;
        if (p.files !== undefined) changes.files = p.files;
        if (p.implementationPlan !== undefined)
          changes.implementationPlan = p.implementationPlan;
        if (p.executionRecord !== undefined)
          changes.executionRecord = p.executionRecord;
        const result = await updateTask(ctx, p.taskId, changes, !!p.overwriteArrays);

        const updateHints: string[] = [];
        // Required-field-shaped hints first
        if (willOverwriteShrinkable) {
          updateHints.push(
            ...overwriteShrinkHints(
              {
                acceptanceCriteria: p.acceptanceCriteria as unknown[] | undefined,
                decisions: p.decisions as unknown[] | undefined,
                files: p.files,
              },
              {
                acceptanceCriteria: priorAcceptanceCriteria,
                decisions: priorDecisions,
                files: priorFiles,
              },
            ),
          );
        }
        if (p.tags && p.tags.length > 0) {
          updateHints.push(...tagVariantHints(p.tags, preExistingTags));
          updateHints.push(...tagTaxonomyHints(p.tags));
        }
        updateHints.push(...descriptionSizeHints(p.description));
        updateHints.push(...acQualityHints(p.acceptanceCriteria));
        updateHints.push(
          ...draftFieldHints(p.status, {
            executionRecord: p.executionRecord,
            implementationPlan: p.implementationPlan,
          }),
        );
        // Status-transition steering
        if (p.status === "planned") {
          updateHints.push(
            "Planned. Plan saved. Task surfaces in mymir_analyze type='ready' once depends_on chain reaches done. To claim: status='in_progress'.",
          );
        }
        if (p.status === "in_progress") {
          updateHints.push(
            "Claimed (one worker per task; lifecycle §1). Run mymir_context depth='agent' for multi-hop deps and upstream executionRecords before starting.",
          );
          updateHints.push(
            "Before marking done: confirm with the user (direct mode) or return one-sentence summary to the orchestrator (dispatched mode). Completion Protocol (lifecycle §2).",
          );
        }
        if (p.status === "done") {
          updateHints.push(
            ...doneStatusHints(
              {
                executionRecord: p.executionRecord,
                decisions: p.decisions as Decision[] | undefined,
                files: p.files,
              },
              {
                executionRecord: result.executionRecord,
                decisions: result.decisions as Decision[] | null,
                files: result.files,
                acceptanceCriteria:
                  result.acceptanceCriteria as { checked: boolean }[] | null,
              },
            ),
          );
        }
        if (p.status === "cancelled") {
          updateHints.push(
            ...cancelledStatusHints(
              {
                executionRecord: p.executionRecord,
                decisions: p.decisions as Decision[] | undefined,
              },
              {
                executionRecord: result.executionRecord,
                decisions: result.decisions as Decision[] | null,
              },
            ),
          );
        }
        if (
          priorStatus !== undefined &&
          p.status !== undefined &&
          priorStatus !== p.status
        ) {
          updateHints.push(...terminalReversalHints(priorStatus, p.status));
          updateHints.push(...statusJumpHints(priorStatus, p.status));
        }
        return ok(
          updateHints.length > 0 ? { ...result, _hints: updateHints } : result,
        );
      }
      case "delete": {
        if (!p.taskId)
          return fail(
            "taskId required for delete. Use mymir_query type='search' to find it.",
          );
        if (p.preview !== false) {
          const result = await deleteTaskPreview(ctx, p.taskId);
          return ok({
            ...result,
            _hints: [
              "Preview only. For abandoned scope, prefer status='cancelled' (preserves rationale + transitive dep semantics). To actually delete (only when the task is noise: accidental, duplicate, never had content), re-run with preview=false.",
            ],
          });
        }
        return ok(await deleteTask(ctx, p.taskId));
      }
    }
  } catch (e) {
    return translateError(e);
  }
}

/**
 * Handle mymir_edge actions.
 * @param p - Validated edge params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with edge data.
 */
export async function handleEdge(
  p: EdgeParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.action) {
      case "create": {
        if (!p.sourceTaskId || !p.targetTaskId)
          return fail(
            "sourceTaskId and targetTaskId required for create. Use mymir_query type='search' to find task IDs.",
          );
        if (!p.edgeType)
          return fail(
            "edgeType required for create. depends_on=source needs target's output (target must be done first); relates_to=informational link, neither blocks. Litmus: removing the target makes source impossible → depends_on; just makes it harder → relates_to. Artifacts §3.",
          );
        if (!p.note || !p.note.trim())
          return fail(
            "note required for create. Edge notes propagate to downstream agent context; placeholders ('needed', 'depends', 'related') are forbidden (artifacts §3). Write it as a brief to the developer about to start the source task: what specifically does this task get from the target?",
          );
        const edge = await createEdge(ctx, {
          sourceTaskId: p.sourceTaskId,
          targetTaskId: p.targetTaskId,
          edgeType: p.edgeType as EdgeType,
          note: p.note,
        });
        return ok(edge);
      }
      case "update": {
        if (!p.edgeId)
          return fail(
            "edgeId required for update. Use mymir_query type='edges' to find edge IDs.",
          );
        if (p.edgeType === undefined && p.note === undefined)
          return fail(
            "update requires at least one of: edgeType, note. To remove the edge, use action='remove'.",
          );
        return ok(
          await updateEdge(ctx, p.edgeId, {
            edgeType: p.edgeType as EdgeType | undefined,
            note: p.note,
          }),
        );
      }
      case "remove": {
        if (p.edgeId) {
          await removeEdge(ctx, p.edgeId);
          return ok({ removed: p.edgeId });
        }
        if (p.sourceTaskId && p.targetTaskId && p.edgeType) {
          const edge = await findEdgeByNodes(
            ctx,
            p.sourceTaskId,
            p.targetTaskId,
            p.edgeType as EdgeType,
          );
          if (!edge) {
            return fail(
              `No matching edge for ${p.sourceTaskId} -[${p.edgeType}]-> ${p.targetTaskId}. Use mymir_query type='edges' to list current edges on either task.`,
            );
          }
          await removeEdge(ctx, edge.id);
          return ok({ removed: edge.id });
        }
        return fail(
          "Provide edgeId OR sourceTaskId+targetTaskId+edgeType. Use mymir_query type='edges' to find edge details.",
        );
      }
    }
  } catch (e) {
    return translateError(e);
  }
}

/**
 * Handle mymir_query actions.
 * @param p - Validated query params. projectId required for search/list/overview.
 * @param ctx - Resolved auth context.
 * @returns Tool result with query data.
 */
export async function handleQuery(
  p: QueryParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.type) {
      case "search": {
        if (!p.projectId) return fail("projectId required for search. Run mymir_project action='list' first.");
        const hasQuery = (p.query?.trim() ?? "").length > 0;
        const tagFilter = normalizeTags(p.tags);
        if (!hasQuery && tagFilter.length === 0) {
          return fail("query or tags required for search. Pass `query` (taskRef, title or tag substring) or `tags=[...]` (exact tag, OR-within).");
        }

        const variantHints =
          tagFilter.length > 0
            ? tagVariantHints(
                tagFilter,
                (await getProjectTags(ctx, p.projectId)).map((t) => t.tag),
              )
            : [];

        const results = await searchTasks(ctx, p.projectId, p.query, tagFilter);
        const hintParts: string[] = [...variantHints];
        if (results.length === 1) hintParts.push(stateHint(results[0].state));
        const hint = hintParts.length > 0 ? hintParts.join("\n> ") : undefined;
        return ok(formatSearchResults(results, hint));
      }
      case "list": {
        if (!p.projectId) return fail("projectId required for list. Run mymir_project action='list' first.");
        return ok(formatTaskList(await getProjectTasksSlim(ctx, p.projectId)));
      }
      case "edges": {
        if (!p.taskId)
          return fail(
            "taskId required for edges. Use type='search' to find task IDs.",
          );
        return ok(formatDetailedEdges(await getTaskEdgesDetailed(ctx, p.taskId)));
      }
      case "meta": {
        if (!p.projectId) return fail("projectId required for meta. Run mymir_project action='list' first.");
        return ok(formatProjectMeta(await getProjectMeta(ctx, p.projectId)));
      }
      case "overview": {
        if (!p.projectId) return fail("projectId required for overview. Run mymir_project action='list' first.");
        const overview = await buildProjectOverview(ctx, p.projectId);
        return ok(overview ? formatOverview(overview) : "Project not found.");
      }
    }
  } catch (e) {
    return translateError(e);
  }
}

/**
 * Handle mymir_context actions. Returns structured data for summary depth,
 * formatted string for other depths.
 * @param p - Validated context params. projectId required for working depth.
 * @param ctx - Resolved auth context.
 * @returns Tool result.
 */
export async function handleContext(
  p: ContextParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.depth) {
      case "summary":
        return ok(formatSummary(await buildSummaryContext(ctx, p.taskId)));
      case "working": {
        if (!p.projectId)
          return fail("projectId required for working depth. Run mymir_project action='list' or pass the projectId you already have.");
        // assertTaskAccess gates on membership; the projectId comparison protects
        // against passing a different project's UUID alongside our own task.
        const task = await assertTaskAccess(p.taskId, ctx);
        if (task.projectId !== p.projectId) {
          return fail(
            `Task '${p.taskId}' belongs to project '${task.projectId}', not '${p.projectId}'. Run mymir_query type='search' to find the correct projectId.`,
          );
        }
        const result = await buildWorkingContext(ctx, p.taskId);
        return ok(await formatWorkingContext(result));
      }
      case "agent":
        return ok(await buildAgentContext(ctx, p.taskId));
      case "planning":
        return ok(await buildPlanningContext(ctx, p.taskId));
    }
  } catch (e) {
    return translateError(e);
  }
}

/**
 * Handle mymir_analyze actions.
 * @param p - Validated analyze params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with analysis data.
 */
export async function handleAnalyze(
  p: AnalyzeParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.type) {
      case "ready": {
        if (!p.projectId) return fail("projectId required for ready. Run mymir_project action='list' first.");
        return ok(formatReadyTasks(await getReadyTasks(ctx, p.projectId)));
      }
      case "blocked": {
        if (!p.projectId) return fail("projectId required for blocked. Run mymir_project action='list' first.");
        return ok(formatBlockedTasks(await getBlockedTasks(ctx, p.projectId)));
      }
      case "downstream": {
        if (!p.taskId)
          return fail(
            "taskId required for downstream analysis. Use mymir_query type='search' to find it.",
          );
        return ok(formatDownstream(await getDownstream(ctx, p.taskId)));
      }
      case "critical_path": {
        if (!p.projectId) return fail("projectId required for critical_path. Run mymir_project action='list' first.");
        return ok(formatCriticalPath(await getCriticalPath(ctx, p.projectId)));
      }
      case "plannable": {
        if (!p.projectId) return fail("projectId required for plannable. Run mymir_project action='list' first.");
        return ok(
          formatPlannableTasks(await getPlannableTasks(ctx, p.projectId)),
        );
      }
    }
  } catch (e) {
    return translateError(e);
  }
}
