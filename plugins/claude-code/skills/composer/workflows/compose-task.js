/**
 * compose-task — the composer per-task pipeline.
 *
 * Launched once per task by the composer orchestrator (skills/composer/SKILL.md)
 * via Workflow({ scriptPath, args }). Runs research+plan → implement → CI →
 * review → bounded fix loop entirely off the orchestrator's context, dispatching
 * the existing composer phase agents by agentType with per-phase model/effort and
 * worktree isolation on the implementer. Returns one structured result; the
 * orchestrator owns the interactive seams (gates, merge, propagation).
 *
 * Args (orchestrator → workflow):
 *   taskRef, taskId, projectId, categories, tagVocabulary,
 *   pickEstimate, pickPriority, workType, tags, thinDescription,
 *   mode, plannableOnly, resumeFrom, priorBrief, gateAnswers, fixFindings,
 *   prUrl, priorFailure, estimate, flags, fable
 *
 * Return shapes:
 *   { status:'DONE', outcome:'in_review'|'planned', verdict, prUrl, ciState,
 *     acSatisfied, acTotal, rotations, escalated, blockingFindings, concerns }
 *   { status:'NEEDS_DECISION', phase, gate, brief }
 *   { status:'BLOCKED', phase, reason }
 */

export const meta = {
  name: "compose-task",
  description:
    "Run one Piyaz task through a merged research+plan phase, implement, CI gate, review, and a bounded fix loop until the PR is ready",
  phases: [
    { title: "Research+Plan" },
    { title: "Implement" },
    { title: "CI gate" },
    { title: "Review" },
  ],
};

const MERGED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "brief",
    "confidence",
    "estimate",
    "workType",
    "flags",
    "proposedRewrites",
    "openQuestions",
    "sections",
    "buildSteps",
    "gatePhase",
    "reason",
  ],
  properties: {
    status: { enum: ["DONE", "DONE_WITH_CONCERNS", "NEEDS_DECISION", "BLOCKED"] },
    brief: { type: "string", description: "The full markdown research brief, verbatim." },
    confidence: { type: "number" },
    estimate: { type: ["integer", "null"], description: "Refined Fibonacci estimate (1,2,3,5,8,13) or null." },
    workType: { type: ["string", "null"], description: "feat|fix|refactor|docs|test|chore|perf." },
    flags: { type: "array", items: { type: "string" } },
    proposedRewrites: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "proposed", "rationale"],
        properties: {
          field: { type: "string" },
          proposed: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
    openQuestions: { type: "array", items: { type: "string" } },
    sections: { type: "integer", description: "Section count of the saved implementationPlan; 0 when no plan was written." },
    buildSteps: { type: "integer", description: "Build-step count of the saved implementationPlan; 0 when no plan was written." },
    gatePhase: { enum: ["research", "plan", null], description: "Which half raised NEEDS_DECISION or BLOCKED; null otherwise." },
    reason: { type: "string", description: "One-line STATUS reason." },
  },
};

const IMPL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "prUrl", "acSatisfied", "acTotal", "concerns", "reason"],
  properties: {
    status: { enum: ["DONE", "DONE_WITH_CONCERNS", "BLOCKED"] },
    prUrl: { type: ["string", "null"] },
    branch: { type: ["string", "null"] },
    acSatisfied: { type: "integer" },
    acTotal: { type: "integer" },
    concerns: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
};

const CI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state", "failingChecks"],
  properties: {
    state: { enum: ["green", "red", "pending", "none"] },
    failingChecks: { type: "array", items: { type: "string" } },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "verdict", "blockingFindings", "concerns", "ciOnly"],
  properties: {
    status: { enum: ["DONE", "BLOCKED"] },
    verdict: { enum: ["approve", "request-changes", "block", null] },
    blockingFindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding"],
        properties: {
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          finding: { type: "string" },
        },
      },
    },
    concerns: { type: "array", items: { type: "string" } },
    ciOnly: { type: "boolean", description: "True when every blocking finding requires no code change (pending CI the sole blocker)." },
    reason: { type: ["string", "null"] },
  },
};

/**
 * Resolves the workflow args, tolerating both an object and a JSON string.
 * The harness passes `args` verbatim; some serialization paths deliver it as a
 * JSON-encoded string, which would otherwise leave every field undefined.
 * @param {unknown} raw - The global `args` value.
 * @returns {object} The args object.
 */
function resolveArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string" && raw.trim()) return JSON.parse(raw);
  return {};
}

const a = resolveArgs(args);
const PHASE_ORDER = ["research", "plan", "implement", "fix"];
const RISK_TAGS = ["security", "safety", "compliance"];
const RISK_FLAGS = ["security-boundary-uncovered", "version-drift-major", "dep-mismatch"];

/**
 * Reports whether a phase should run given the resume point.
 * @param {string} phaseName - One of PHASE_ORDER.
 * @returns {boolean} True when phaseName is at or after the resume point.
 */
function shouldRun(phaseName) {
  const from = a.resumeFrom || "research";
  return PHASE_ORDER.indexOf(phaseName) >= PHASE_ORDER.indexOf(from);
}

/**
 * Reports whether any tag in a list is risk-bearing.
 * @param {string[]} tags - Tag list.
 * @returns {boolean} True when a security/safety/compliance tag is present.
 */
function hasRiskTag(tags) {
  return (tags || []).some((t) => RISK_TAGS.includes(t));
}

/**
 * Reports whether the implementer/planner must be forced to opus.
 * @param {number|null} est - Refined estimate.
 * @param {string[]} flags - Research flags.
 * @returns {boolean} True when a guardrail forces the smartest tier.
 */
function forceOpus(est, flags) {
  const riskFlag = (flags || []).some((f) => RISK_FLAGS.includes(f));
  return (
    hasRiskTag(a.tags) ||
    est == null ||
    est >= 8 ||
    a.priorFailure != null ||
    a.pickPriority === "urgent" ||
    riskFlag
  );
}

let fableFailed = false;

/**
 * Reports whether a dispatch qualifies for the fable tier.
 * @param {number|null} est - Estimate (refined when available, else pick-time).
 * @param {string[]} flags - Research flags.
 * @returns {boolean} True when the complexity guardrails fire.
 */
function fableGuardrails(est, flags) {
  const riskFlag = (flags || []).some((f) => RISK_FLAGS.includes(f));
  return (est != null && est >= 8) || hasRiskTag(a.tags) || riskFlag || a.priorFailure != null;
}

/**
 * Selects the top model tier: fable when enabled and healthy, else opus.
 * @returns {string} Model alias.
 */
function topModel() {
  return a.fable !== "off" && !fableFailed ? "fable" : "opus";
}

/**
 * Dispatches an agent, falling back to opus once when a fable dispatch fails.
 * A failure (throw or null return) disables fable for the rest of the run.
 * @param {string} prompt - The dispatch prompt.
 * @param {object} opts - agent() options.
 * @returns {Promise<any>} The agent result, or null on a non-fable failure.
 */
async function dispatch(prompt, opts) {
  if (opts.model !== "fable") return agent(prompt, opts);
  let out = null;
  try {
    out = await agent(prompt, opts);
  } catch {
    out = null;
  }
  if (out != null) return out;
  fableFailed = true;
  log("fable dispatch failed; falling back to opus for the run");
  return agent(prompt, { ...opts, model: "opus" });
}

/**
 * Selects the implementer model from the refined estimate and work type.
 * @param {number|null} est - Refined estimate.
 * @param {string|null} wt - Work type.
 * @param {string[]} flags - Research flags.
 * @returns {string} Model alias.
 */
function implementModel(est, wt, flags) {
  if (forceOpus(est, flags)) return "opus";
  if ((est != null && est <= 2) || ["docs", "test", "chore"].includes(wt)) return "sonnet";
  return "opus";
}

/**
 * Builds a NEEDS_DECISION return for an orchestrator gate.
 * @param {string} phase - Raising phase.
 * @param {object} result - The phase's structured result.
 * @param {string} [briefText] - Brief to carry through (plan gate).
 * @returns {object} Gate result.
 */
function gateResult(phase, result, briefText) {
  return {
    status: "NEEDS_DECISION",
    phase,
    taskRef: a.taskRef,
    gate: {
      flags: result.flags || [],
      proposedRewrites: result.proposedRewrites || [],
      openQuestions: result.openQuestions || [],
      confidence: result.confidence,
      reason: result.reason,
    },
    brief: briefText || result.brief,
  };
}

/**
 * Builds a BLOCKED return.
 * @param {string} phase - Failing phase.
 * @param {string} reason - One-line reason.
 * @returns {object} Blocked result.
 */
function blockedResult(phase, reason) {
  return { status: "BLOCKED", phase, taskRef: a.taskRef, reason: reason || "no reason reported" };
}

/**
 * Formats review blocking findings into a fix-dispatch bullet list.
 * @param {Array<{file?:string,line?:number,finding:string}>} findings - Findings.
 * @returns {string} Newline-joined bullets.
 */
function formatFindings(findings) {
  return (findings || [])
    .map((f) => `- ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : ""}${f.finding}`)
    .join("\n");
}

const head = `Target task: ${a.taskRef} (taskId ${a.taskId}) in project ${a.projectId}. Pass that projectId on every Piyaz tool call.`;

const PROVISION =
  "Worktree provisioning: a worktree checkout omits gitignored files. Before editing code, copy from the primary checkout " +
  "(first entry of `git worktree list --porcelain`) into the worktree root when absent: the project's agent-instruction files " +
  "(CLAUDE.md, AGENTS.md, GEMINI.md, or equivalent), the env file the repo documents (.env.local or equivalent), named design " +
  "references (DESIGN.md or equivalent), and any documented local test login. Read and follow the project agent-instruction file " +
  "and your user-level one. Never commit or force-add the copies; never leak credentials into code, docs, PR bodies, or Piyaz records. " +
  "Non-code deliverables must be reviewable: commit repo-resident artifacts in the PR; otherwise link them on the task or record " +
  "the path or URL plus the exact regeneration command in a Deliverables section of the executionRecord.";

// --- Research+Plan ------------------------------------------------------------
phase("Research+Plan");
let brief = a.priorBrief;
let merged = null;
let planQuestions = [];
if (shouldRun("plan")) {
  const reResearch = shouldRun("research");
  const entryStatus = a.plannableOnly ? "draft" : a.mode === "single" ? "unknown" : "draft|planned";
  const prompt =
    `${head}\nProject categories and tags: ${a.categories}; ${a.tagVocabulary}.\nEntry status: ${entryStatus}.\n` +
    "Merged mandate: you research AND plan this task in one pass. Orchestrator authority grant: the phase-1 restriction against writing implementationPlan or status is lifted for this dispatch. " +
    "After the research pass, design the architecture yourself; the Agent tool is unavailable in workflow dispatches, so never plan to dispatch a subagent. " +
    "Write the full implementationPlan to Piyaz and flip draft to planned in the same piyaz_edit call. " +
    "If the plan write cannot complete, return NEEDS_DECISION with gatePhase='plan', never DONE." +
    (reResearch ? "" : `\nPrior research brief (do not re-research):\n${brief}`) +
    (a.gateAnswers ? `\nOpen questions resolved by the user:\n${a.gateAnswers}` : "");
  merged = await dispatch(prompt, {
    agentType: "piyaz:composer-researcher",
    model: fableGuardrails(a.pickEstimate, a.flags) ? topModel() : "opus",
    effort: a.pickEstimate == null || a.pickEstimate >= 8 || hasRiskTag(a.tags) ? "xhigh" : "high",
    schema: MERGED_SCHEMA,
    label: `research+plan:${a.taskRef}`,
    phase: "Research+Plan",
  });
  if (!merged) return blockedResult("plan", "research+plan agent returned no result");
  brief = merged.brief || brief;
  if (merged.status === "NEEDS_DECISION") return gateResult(merged.gatePhase || "plan", merged);
  if (merged.status === "BLOCKED") return blockedResult(merged.gatePhase || "plan", merged.reason);
  if (!(merged.sections > 0 || merged.buildSteps > 0))
    return gateResult("plan", { ...merged, reason: "DONE without a saved plan: sections and buildSteps are 0" });
  planQuestions = merged.openQuestions || [];
}

const est = merged ? merged.estimate : (a.estimate != null ? a.estimate : a.pickEstimate);
const wt = merged ? merged.workType : a.workType;
const flags = merged ? merged.flags : a.flags || [];

if (a.plannableOnly) {
  return {
    status: "DONE",
    phase: "plan",
    outcome: "planned",
    taskRef: a.taskRef,
    reason: "plannable-only pick planned; dependencies unfinished",
  };
}

// --- Implement --------------------------------------------------------------
phase("Implement");
let prUrl = a.prUrl;
let acSatisfied = null;
let acTotal = null;
let concerns = [];
if (shouldRun("implement")) {
  const prompt =
    `${head} Plan is saved to Piyaz; fetch via piyaz_get lens='agent'. ` +
    "Claim the task, implement per the implementationPlan, open a PR, mark in_review per the Completion Protocol.\n" +
    PROVISION +
    (planQuestions.length
      ? `\nOpen questions from planning — resolve or escalate before guessing:\n- ${planQuestions.join("\n- ")}`
      : "") +
    (a.priorFailure ? `\nPrior failed attempt:\n${a.priorFailure}` : "");
  const impl = await dispatch(prompt, {
    agentType: "piyaz:composer-implementer",
    model: fableGuardrails(est, flags) ? topModel() : implementModel(est, wt, flags),
    effort: forceOpus(est, flags) || (est != null && est >= 5) ? "high" : "medium",
    isolation: "worktree",
    schema: IMPL_SCHEMA,
    label: `implement:${a.taskRef}`,
    phase: "Implement",
  });
  if (!impl) return blockedResult("implement", "implementer returned no result");
  if (impl.status === "BLOCKED") return blockedResult("implement", impl.reason);
  prUrl = impl.prUrl || prUrl;
  acSatisfied = impl.acSatisfied;
  acTotal = impl.acTotal;
  concerns = impl.concerns || [];
}

// --- CI gate → Review → bounded fix loop ------------------------------------
// A rework launch (resumeFrom='fix' with human findings) seeds the loop so the
// first rotation addresses those findings before any fresh review runs; the
// human already reviewed. Every other entry starts with a CI gate and review.
let rotations = 0;
let ciRepolls = 0;
let lastReview = null;
let ciState = "unknown";
let pendingFindings = a.resumeFrom === "fix" && a.fixFindings ? a.fixFindings : null;

while (true) {
  if (pendingFindings == null) {
    phase("CI gate");
    const ci = await agent(
      `Poll CI for pull request ${prUrl} and report status. Run exactly this single command:\n` +
        `timeout 660 bash -c 'while :; do out=$(gh pr checks ${prUrl} 2>&1); code=$?; [ $code -ne 8 ] && { printf "%s\\n" "$out"; exit $code; }; sleep 60; done'; echo "exit=$?"\n` +
        "It polls once a minute, 11 gh calls at most; never re-run it in a tighter loop. " +
        "Interpret the exit code: 0 means green; 8 or 124 means pending (checks still running after the poll budget); any other non-zero means red, UNLESS the output says no checks are reported, which is none. " +
        "On red, read the failing check names from the output. Do not edit any files; only report.",
      { model: "haiku", effort: "low", schema: CI_SCHEMA, label: `ci:${a.taskRef}`, phase: "CI gate" },
    );
    ciState = ci ? ci.state : "pending";
    const failing = ci && ci.failingChecks ? ci.failingChecks.join(", ") : "";

    phase("Review");
    const ciNote =
      ciState === "red"
        ? ` CI: failing (${failing})`
        : ciState === "pending"
          ? " CI: unresolved after 10m"
          : "";
    lastReview = await agent(
      `${head} PR URL: ${prUrl}. Mode: composer-phase-4.${ciNote} ` +
        "Run the comments-and-docs audit and, when the task names output artifacts, deliverable verification per your rules. " +
        "Set ciOnly=true when every blocking finding requires no code change (pending CI only).",
      {
        agentType: "piyaz:review",
        model: "opus",
        effort: "high",
        schema: VERDICT_SCHEMA,
        label: `review:${a.taskRef}`,
        phase: "Review",
      },
    );
    if (!lastReview) return blockedResult("review", "reviewer returned no result");
    if (lastReview.status === "BLOCKED")
      return blockedResult("review", lastReview.reason || "reviewer could not run");
    if (lastReview.verdict == null)
      return blockedResult("review", lastReview.reason || "reviewer returned no verdict");

    if (lastReview.verdict === "approve") break;
    if (lastReview.verdict === "request-changes" && lastReview.ciOnly) {
      ciRepolls++;
      if (ciRepolls > 2) break;
      log(`CI unresolved with no code-change findings; re-poll ${ciRepolls}/2 on ${a.taskRef}`);
      continue;
    }
    if (lastReview.verdict === "block" || rotations >= 2) break;
    pendingFindings = formatFindings(lastReview.blockingFindings);
  }

  rotations++;
  log(`fix rotation ${rotations}/2 on ${a.taskRef}`);
  phase("Implement");
  const fix = await dispatch(
    `${head} Fix mode. PR: ${prUrl}. Address exactly these review findings, re-run verification, re-mark in_review. ` +
      "Restructure the executionRecord to state the final shipped state like a PR body: fold the fix into the relevant sections; no per-rotation narrative paragraphs.\n" +
      `${PROVISION}\nFindings:\n${pendingFindings}`,
    {
      agentType: "piyaz:composer-implementer",
      model: rotations >= 2 || fableGuardrails(est, flags) ? topModel() : "opus",
      effort: "high",
      isolation: "worktree",
      schema: IMPL_SCHEMA,
      label: `fix:${a.taskRef}#${rotations}`,
      phase: "Implement",
    },
  );
  if (!fix) return blockedResult("fix", "fix implementer returned no result");
  if (fix.status === "BLOCKED") return blockedResult("fix", fix.reason);
  prUrl = fix.prUrl || prUrl;
  if (fix.acSatisfied != null) acSatisfied = fix.acSatisfied;
  if (fix.acTotal != null) acTotal = fix.acTotal;
  pendingFindings = null;
}

const escalated =
  lastReview.verdict === "block" || (lastReview.verdict === "request-changes" && rotations >= 2);

return {
  status: "DONE",
  phase: "review",
  outcome: "in_review",
  taskRef: a.taskRef,
  verdict: lastReview.verdict,
  prUrl,
  ciState,
  acSatisfied,
  acTotal,
  rotations,
  escalated,
  blockingFindings: lastReview.verdict === "approve" ? [] : lastReview.blockingFindings || [],
  concerns,
};
