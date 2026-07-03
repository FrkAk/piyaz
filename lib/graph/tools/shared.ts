/**
 * Shared substrate for the 8 MCP tool handlers: the ToolResult shape,
 * ref-resolution helpers, the hint families that steer agents at runtime,
 * and the error translator that turns thrown domain errors into token-dense
 * corrective messages. Business logic lives in lib/data/* and
 * lib/context/_core/*; this layer is validation, routing, and steering.
 */

import type { TaskState } from "@/lib/data/task";
import type { Decision } from "@/lib/types";
import type { AuthContext } from "@/lib/auth/context";
import {
  MultiTeamAmbiguityError,
  NoTeamMembershipError,
  TaskLimitError,
  SelfEdgeError,
  CrossProjectEdgeError,
  DuplicateEdgeError,
  EdgeCycleError,
  SearchCriteriaRequiredError,
} from "@/lib/graph/errors";
import {
  resolveProjectRef,
  resolveTaskRef,
  RefAmbiguityError,
  MalformedRefError,
  RefNotFoundError,
} from "@/lib/data/resolve-ref";
import {
  StaleWriteError,
  StrReplaceNoMatchError,
  StrReplaceMultipleMatchError,
  CollectionItemNotFoundError,
  InvalidEditOpError,
  DuplicateLinkUrlError,
} from "@/lib/data/task-edit";
import {
  BatchInputError,
  DuplicateTaskTitleError,
} from "@/lib/data/task-batch";
import { RecordNotTerminalError } from "@/lib/context/_core/bundle";
import { WORK_TYPE_TAGS, findVariant } from "@/lib/graph/tag-similarity";
import {
  ForbiddenError,
  InsufficientRoleError,
} from "@/lib/auth/authorization";
import { unwrapDriverError } from "@/lib/db/errors";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Discriminated result from a tool handler. */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/** @returns Success result wrapping data. */
export function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

/** @returns Failure result with actionable message. */
export function fail(msg: string): ToolResult {
  return { ok: false, error: msg };
}

// ---------------------------------------------------------------------------
// Ref resolution wrappers
// ---------------------------------------------------------------------------

/**
 * Resolve a task param (taskRef or UUID) to a task UUID. Thin wrapper so
 * handlers stay one-liner; resolution errors are translated by
 * {@link translateError} at the handler boundary.
 *
 * @param ctx - Resolved auth context.
 * @param taskParam - taskRef ('PYZ-42') or task UUID.
 * @returns The task UUID.
 */
export async function requireTaskId(
  ctx: AuthContext,
  taskParam: string,
): Promise<string> {
  return (await resolveTaskRef(ctx, taskParam)).taskId;
}

/**
 * Resolve a project param (identifier or UUID) to a project UUID.
 *
 * @param ctx - Resolved auth context.
 * @param projectParam - Project identifier ('PYZ') or project UUID.
 * @returns The project UUID.
 */
export async function requireProjectId(
  ctx: AuthContext,
  projectParam: string,
): Promise<string> {
  return (await resolveProjectRef(ctx, projectParam)).projectId;
}

// ---------------------------------------------------------------------------
// Hint families (runtime steering)
// ---------------------------------------------------------------------------

/**
 * Build variant-warning hints for proposed tags against existing project tags.
 * @param proposed - Proposed tag strings.
 * @param existing - Current project tag list.
 * @returns Hint strings for tags that look like variants of existing ones.
 */
export function tagVariantHints(
  proposed: string[],
  existing: string[],
): string[] {
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
 * Edge-note values that are too thin to carry downstream-agent context.
 * The MCP descriptions document this exact list ("placeholders ('needed',
 * 'depends', 'related') are rejected"); enforcing it here keeps the
 * runtime contract aligned with the doc string. Matched case-insensitively
 * after trimming.
 */
export const EDGE_NOTE_PLACEHOLDERS = new Set(["needed", "depends", "related"]);

/**
 * Build hints for tag-taxonomy violations. Kebab-case is structural and
 * universal. The work-type dimension check is heuristic: the server
 * matches against the canonical English closed vocabulary documented in
 * `references/artifacts.md` §2, but Piyaz runs across projects authored
 * in any language. When the canonical match misses, the hint refers the
 * agent to the reference rather than enumerating English values inline,
 * so localized tag sets are not penalized.
 *
 * @param tags - Proposed tag list (already normalized for whitespace).
 * @returns Hint strings; empty array when the tag set passes all checks.
 */
export function tagTaxonomyHints(tags: string[]): string[] {
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
  if (!lowered.some((t) => WORK_TYPE_TAGS.has(t))) {
    hints.push(
      `Could not detect work-type dimension tag from the canonical vocabulary. Every task carries three tag dimensions (work-type, cross-cutting concern, tech) plus the priority field; see artifacts §2 for the canonical closed-vocabulary terms. Projects authored in other languages may use equivalent localized tags; in that case this hint is heuristic, verify the dimension is present in your project's idiom and ignore.`,
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
export function descriptionSizeHints(
  description: string | undefined,
): string[] {
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
 * the task is two tasks.
 *
 * @param criteria - Proposed acceptance-criteria array.
 * @returns Hints; empty when count is in band or array is absent.
 */
export function acQualityHints(criteria: unknown[] | undefined): string[] {
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
export function draftFieldHints(
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
      "implementationPlan with status='draft' is incomplete (lifecycle §1). Saving an unabridged plan transitions the task to planned; set status='planned' in the same piyaz_edit call.",
    );
  }
  return hints;
}

/**
 * Build a hint when a status transition skips intermediate states
 * (e.g. draft → done, planned → done). The lifecycle is
 * `draft → planned → in_progress → in_review → done`; cancelled is
 * reachable from any non-terminal and is handled by
 * {@link terminalReversalHints}.
 *
 * @param priorStatus - The task's status before the update.
 * @param nextStatus - The status the caller is transitioning to.
 * @returns Hint strings; empty when the transition is monotonic.
 */
export function statusJumpHints(
  priorStatus: string,
  nextStatus: string,
): string[] {
  const order = ["draft", "planned", "in_progress", "in_review", "done"];
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
 * Build warning hints for semantically incoherent terminal-to-terminal
 * status transitions.
 * @param priorStatus - The task's status before the update.
 * @param nextStatus - The status the caller is transitioning to.
 * @returns Hint strings (empty when the transition is normal).
 */
export function terminalReversalHints(
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
export function cancelledStatusHints(
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
  if (
    !payload.decisions &&
    (!persisted.decisions || persisted.decisions.length === 0)
  ) {
    hints.push(
      "Missing decisions. Record technical choices made before cancelling (CHOICE + WHY); preserves what was learned for any future revisit.",
    );
  }
  hints.push(
    "Cancellation is transparent in the dep graph: dependents stay blocked through this task's own unsatisfied prereqs (lifecycle §3). Run piyaz_map view='downstream' and decide deliberately: is there a replacement task? If yes, rewire dependents to it. If not, dependents may need cancelling or re-scoping. Do not decide silently.",
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
export function doneStatusHints(
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
  if (
    !payload.decisions &&
    (!persisted.decisions || persisted.decisions.length === 0)
  ) {
    hints.push(
      "Missing decisions (lifecycle §1). Record technical choices (CHOICE + WHY); downstream tasks need them.",
    );
  }
  if (!payload.files && (!persisted.files || persisted.files.length === 0)) {
    hints.push(
      "Missing files (lifecycle §1). Record every path created or modified. For pure spec-review / docs / decision-only tasks that touched no repo files, set files=[] explicitly so this hint clears.",
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
      "Acceptance criteria are all unchecked. Evaluate each against your executionRecord and check the ones that hold via piyaz_edit op='check' with the item id. Do not auto-check everything.",
    );
  }
  const persistedFiles = payload.files ?? persisted.files ?? [];
  if (persistedFiles.length > 0) {
    hints.push(
      "Code change shipped. Open a PR per Completion Protocol (lifecycle §2 step 3): detect a template (.github/PULL_REQUEST_TEMPLATE.md and variants); fill it concisely from executionRecord and ACs; use [taskRef] bracket form for the ONE primary task this PR builds (triggers Piyaz PR-status tracking). Skip for research / decision-only / Piyaz-only refinements.",
    );
  }
  hints.push(
    "Run piyaz_map view='downstream' to propagate (lifecycle §3): update edge notes, retire stale edges, surface new dependencies revealed by this completion.",
  );
  return hints;
}

/**
 * Compute completion-protocol hints for the implementer's terminal write,
 * `status='in_review'`. Mirrors {@link doneStatusHints} for the
 * executionRecord / decisions / files / AC checks and adds a `prUrl` hint
 * when the task has no `pull_request` link and the payload did not supply
 * one. The PR is the review subagent's primary handle for inspecting the
 * implementer's output, so missing it should be loud.
 *
 * @param payload - Fields supplied by the caller in this request.
 * @param persisted - Row state after the mutation, including persisted links.
 * @returns Hint strings.
 */
export function inReviewStatusHints(
  payload: {
    executionRecord?: string;
    decisions?: Decision[];
    files?: string[];
    prUrl?: string | null;
  },
  persisted: {
    executionRecord?: string | null;
    decisions?: Decision[] | null;
    files?: string[] | null;
    acceptanceCriteria?: { checked: boolean }[] | null;
    links: { kind: string }[];
  },
): string[] {
  const hints: string[] = [];
  if (!payload.executionRecord && !persisted.executionRecord) {
    hints.push(
      "Missing executionRecord (lifecycle §1). Add 3-5 sentences on HOW it was built: function names, file paths, endpoints. Distinct from description (scope). Downstream tasks depend on this for context.",
    );
  }
  if (
    !payload.decisions &&
    (!persisted.decisions || persisted.decisions.length === 0)
  ) {
    hints.push(
      "Missing decisions (lifecycle §1). Record technical choices (CHOICE + WHY); downstream tasks need them.",
    );
  }
  if (!payload.files && (!persisted.files || persisted.files.length === 0)) {
    hints.push(
      "Missing files (lifecycle §1). Record every path created or modified. For pure spec-review / docs / decision-only tasks that touched no repo files, set files=[] explicitly so this hint clears.",
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
      "Acceptance criteria are all unchecked. Evaluate each against your executionRecord and check the ones that hold via piyaz_edit op='check' with the item id. Do not auto-check everything.",
    );
  }
  const hasPrLink = persisted.links.some((l) => l.kind === "pull_request");
  if (payload.prUrl == null && !hasPrLink) {
    hints.push(
      "Missing prUrl. The Completion Protocol writes the PR URL alongside the in_review status flip so the review subagent and detail UI can resolve the PR (lifecycle §2). Add op={op:'set', field:'prUrl', value:'<gh-pr-url>'}. Omit only when no PR was opened (research / docs-only / decision-only tasks).",
    );
  }
  if (
    (persisted.files?.length ?? 0) > 0 &&
    payload.prUrl == null &&
    !hasPrLink
  ) {
    hints.push(
      "Code change shipped without a PR. Open one per Completion Protocol (lifecycle §2 step 3) and set prUrl on the next call. The implementer's terminal write is in_review with the PR attached; HOTL flips to done after approval.",
    );
  }
  hints.push(
    "Next call for the review subagent (composer Phase 4 or direct review dispatch): piyaz_get task='<this ref>' lens='review'. The bundle renders implementationPlan alongside executionRecord, surfaces the PR link, and emits review-lens prompts; no file list is recorded — review the actual changes from the PR diff.",
  );
  hints.push(
    "Run piyaz_map view='downstream' to propagate (lifecycle §3): update edge notes, retire stale edges, surface new dependencies revealed by this completion.",
  );
  return hints;
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
export const STATE_HINTS: Record<TaskState, string> = {
  plannable:
    "Plannable. Recommend this task to the user (direct mode) or return to the orchestrator (dispatched mode); wait for explicit pick before acting. After confirmation: write the implementation plan, then set status='planned'. Fetch piyaz_get lens='planning' (project description, upstream executionRecords, downstream specs). Before writing: search the codebase for what already exists, read current docs for any new dependency, reason through edge cases. No speculation. Save the unabridged plan; do not summarize.",
  ready:
    "Ready. Recommend this task to the user (direct mode) or return to the orchestrator (dispatched mode); wait for explicit pick before claiming. After confirmation: set status='in_progress' to claim, then fetch piyaz_get lens='agent' (multi-hop deps, upstream executionRecords, downstream specs); read the relevant code; refer to current docs; reason through edge cases. Understand before doing.",
  blocked:
    "Blocked. Cannot advance until upstream deps complete. Run piyaz_map view='blocked' for blocker details, or piyaz_get lens='summary' for this task's edges. Surface the choices to the user/leader: pick a different ready task, or unblock by completing a dep. Do not pick silently.",
  in_progress:
    "Claimed (one worker per task; lifecycle §1). Take-over is not automatic: confirm with the user (direct mode) or orchestrator (dispatched mode) that the prior worker has gone away before resuming. After confirmation: fetch piyaz_get lens='agent', read prior notes plus upstream executionRecords. To finish: populate executionRecord, decisions, files, evaluate every AC by id (do not auto-check), open a PR if files changed, then set status='in_review' (the implementer's terminal write; HOTL flips to done after PR approval) per the Completion Protocol (lifecycle §2).",
  in_review:
    "In review (implementer terminal write; lifecycle §1). The implementer subagent has shipped the PR with tests green and populated executionRecord/decisions/files/acceptanceCriteria. The HOTL operator inspects the PR and flips to `done` after approval, or back to `in_progress` if rework is required. Agents do not self-promote to `done` from here; surface the PR for review and stop.",
  done: "Terminal (HOTL-finalized). The PR has been approved and the operator has flipped the task from `in_review` to `done`. Fetch piyaz_get lens='record' for the retrospective (outcome, decisions, PR link — no file list is rendered; the PR diff is the source of truth for what changed). Then piyaz_map view='downstream' to propagate decisions onto dependents (edge notes, descriptions, new edges, stale edges). After propagation, ask the user/leader what's next; do not auto-proceed to another task.",
  cancelled:
    "Terminal (abandoned). Fetch piyaz_get lens='record' for the cancellation rationale (lives in executionRecord) and decisions. Edges remain in place; cancellation is transparent (dependents stay blocked through this task's own unsatisfied deps; lifecycle §3). Ask the user/leader: is there a replacement? If yes, rewire dependents to it. If not, dependents may need cancelling or re-scoping. Do not decide silently.",
  draft:
    "Draft. Not ready to plan. Recommend refinement to the user (direct mode) or orchestrator (dispatched mode); wait for confirmation before editing. After confirmation: fetch piyaz_get lens='working' and tighten description to 2-4 sentences with 2-4 binary acceptance criteria via piyaz_edit ops. Before refining, explore: search related tasks, read current docs, check the codebase. Push back on vagueness; rewrite single-sentence descriptions and 'works correctly' ACs. Once description and ACs are present, the task becomes plannable.",
};

/**
 * Get a next-call hint for a task's derived state.
 * @param state - The derived TaskState.
 * @returns Hint string telling the agent what to do next.
 */
export function stateHint(state: TaskState): string {
  return STATE_HINTS[state];
}

// ---------------------------------------------------------------------------
// Error translation — data-layer asserts throw, this maps to actionable hints
// ---------------------------------------------------------------------------

/**
 * Translate a thrown error to a token-dense, agent-correcting tool failure.
 *
 * Each branch carries a recovery path the agent can execute on its own:
 * candidate lists for ambiguous refs, near-miss suggestions with the max
 * sequence named, occurrence counts for failed str_replace, the current
 * updatedAt for stale writes, current item ids for missed collection
 * targets, and "treat as success" for duplicate edges.
 *
 * Anything else falls through to the opaque catch-all: logged server-side
 * with full context, returned to the client as `Internal error`. Verbose
 * `err.message` forwarding is whitelist-gated to `NODE_ENV === "development"`
 * (i.e. `bun run dev`); every other env value falls through to generic so
 * a silent env change can't start leaking driver internals.
 *
 * @param e - Caught error.
 */
export function translateError(e: unknown): ToolResult {
  if (e instanceof InsufficientRoleError) {
    return fail(
      `Forbidden: only team admins can ${e.primaryAction} projects. Tell the user; they need a team admin to do this.`,
    );
  }
  if (e instanceof MultiTeamAmbiguityError) {
    const list = e.teams.map((t) => `${t.name} (${t.id})`).join(", ");
    return fail(
      `organizationId required: multi-team account. Teams: ${list}. Ask the user which team, then retry with organizationId='<uuid>'. piyaz_workspace action='teams' returns the same list anytime, with role + projectCount.`,
    );
  }
  if (e instanceof NoTeamMembershipError) {
    return fail(
      "No team membership: the caller does not belong to any team. Ask the user to sign in to the web app and create or join a team, then retry.",
    );
  }
  if (e instanceof TaskLimitError) {
    return fail(
      `${e.message}. Do not retry; clean up cancelled or obsolete tasks in project '${e.projectId}', or ask the operator to raise MAX_TASKS_PER_PROJECT.`,
    );
  }
  if (e instanceof SearchCriteriaRequiredError) {
    return fail(
      "At least one search criterion required: query, status, priority, assignee, category, or tags.",
    );
  }
  if (e instanceof BatchInputError) {
    return fail(
      `${e.message}. Fix the batch payload and retry; no writes happened.`,
    );
  }
  if (e instanceof DuplicateTaskTitleError) {
    return fail(
      `Batch rejected with no writes: title(s) already exist: ${e.titles.join(", ")}. Retry with onDuplicate='skip' to reuse the existing tasks for an idempotent re-run.`,
    );
  }
  if (e instanceof SelfEdgeError || e instanceof CrossProjectEdgeError) {
    return fail(e.message);
  }
  if (e instanceof DuplicateEdgeError) {
    return fail(
      `${e.message} Treat as success; verify with piyaz_map view='neighbors'.`,
    );
  }
  if (e instanceof EdgeCycleError) {
    const chain =
      e.chainTaskIds.length > 0
        ? ` Dependency chain: ${e.chainTaskIds.join(" → ")}.`
        : "";
    return fail(`${e.message}${chain}`);
  }
  if (e instanceof MalformedRefError) {
    return fail(
      `'${e.input}' is not a valid reference. Pass a taskRef like 'PYZ-42' or a UUID (from piyaz_search).`,
    );
  }
  if (e instanceof RefAmbiguityError) {
    const list = e.candidates
      .map(
        (c) =>
          `${c.projectTitle} (${c.teamName}, projectId=${c.projectId}${
            c.taskId ? `, taskId=${c.taskId}` : ""
          })`,
      )
      .join("; ");
    return fail(
      `Ref '${e.ref}' matches ${e.candidates.length} teams: ${list}. Retry with the UUID to disambiguate.`,
    );
  }
  if (e instanceof RefNotFoundError) {
    if (e.projectIdentifier) {
      const upTo =
        e.maxSequenceNumber !== undefined
          ? ` Project ${e.projectIdentifier} has tasks up to ${e.projectIdentifier}-${e.maxSequenceNumber}.`
          : ` Project ${e.projectIdentifier} has no tasks yet.`;
      return fail(
        `Ref '${e.ref}' not found.${upTo} Run piyaz_search to find the right task.`,
      );
    }
    return fail(
      `Ref '${e.ref}' not found in any team you belong to. Run piyaz_search to find the right task, or piyaz_workspace action='projects' for project identifiers.`,
    );
  }
  if (e instanceof RecordNotTerminalError) {
    return fail(
      "lens='record' renders only done/cancelled tasks. For an active task use lens='agent' (implementation shape) or lens='working' (refinement shape).",
    );
  }
  if (e instanceof StaleWriteError) {
    return fail(
      `Task changed since you last read it (updatedAt ${e.currentUpdatedAt.toISOString()}). Re-run piyaz_get, then retry with the fresh ifUpdatedAt.`,
    );
  }
  if (e instanceof StrReplaceNoMatchError) {
    return fail(
      `oldStr matched 0 places in ${e.field}. Re-read the field with piyaz_get fields=['${e.field}'] and copy the exact text including whitespace.`,
    );
  }
  if (e instanceof StrReplaceMultipleMatchError) {
    return fail(
      `oldStr matched ${e.count} places in ${e.field}. Include more surrounding context to make it unique.`,
    );
  }
  if (e instanceof CollectionItemNotFoundError) {
    const items = e.currentItems.map((i) => `${i.id}: ${i.text}`).join(", ");
    return fail(
      `No ${e.collection} item with id '${e.id}'. Current items: ${items}.`,
    );
  }
  if (e instanceof InvalidEditOpError) {
    return fail(e.reason);
  }
  if (e instanceof DuplicateLinkUrlError) {
    return fail(
      `The task already has a link with url '${e.url}'. Update or remove that existing link instead, or use a different url.`,
    );
  }
  if (e instanceof ForbiddenError) {
    const id = e.resourceId ?? "";
    switch (e.resource) {
      case "project":
        return fail(
          `Project '${id}' not found in any team you belong to. Run piyaz_workspace action='projects' to see available projects across all your teams.`,
        );
      case "task":
        return fail(
          `Task '${id}' not found in any team you belong to. Run piyaz_search to find the right task.`,
        );
      case "edge":
        return fail(
          `Edge '${id}' not found. Run piyaz_map view='neighbors' with a task to see its current edges.`,
        );
      case "team":
        return fail(
          e.resourceId
            ? `organizationId '${e.resourceId}' is not a team you belong to. Run piyaz_workspace action='teams' to see valid ids, then ask the user which team before retrying.`
            : e.message,
        );
      default:
        return fail(
          "Not found in any team you belong to. Run piyaz_workspace action='projects' to see what you can access.",
        );
    }
  }
  const driverError = unwrapDriverError(e);
  if (driverError?.code === "23505") {
    const constraint = driverError.constraint_name ?? "";
    if (constraint.includes("identifier")) {
      return fail(
        "Project identifier already in use in this team. Pick a different one (2-12 chars, uppercase alphanumeric).",
      );
    }
    return fail("Conflict: a record with that value already exists.");
  }
  console.error("[graph:tools] unhandled error:", e);
  const verbose = process.env.NODE_ENV === "development";
  return fail(verbose && e instanceof Error ? e.message : "Internal error");
}
