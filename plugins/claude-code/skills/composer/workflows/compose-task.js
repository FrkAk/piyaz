/**
 * compose-task — the composer per-task pipeline.
 *
 * Launched once per task by the composer orchestrator (skills/composer/SKILL.md)
 * via Workflow({ scriptPath, args }). Runs research → plan → implement → CI →
 * review → bounded fix loop entirely off the orchestrator's context, dispatching
 * the existing composer phase agents by agentType with per-phase model/effort and
 * worktree isolation on the implementer. Returns one structured result; the
 * orchestrator owns the interactive seams (gates, merge, propagation).
 *
 * Args (orchestrator → workflow):
 *   taskRef, taskId, projectId, categories, tagVocabulary,
 *   pickEstimate, pickPriority, workType, tags, thinDescription,
 *   mode, plannableOnly, resumeFrom, priorBrief, gateAnswers, fixFindings,
 *   prUrl, priorFailure, estimate, flags
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
    "Run one Piyaz task through research, plan, implement, CI gate, review, and a bounded fix loop until the PR is ready",
  phases: [
    { title: "Research" },
    { title: "Plan" },
    { title: "Implement" },
    { title: "CI gate" },
    { title: "Review" },
  ],
};

const RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "brief", "confidence", "estimate", "workType", "flags", "proposedRewrites", "openQuestions", "reason"],
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
    reason: { type: "string", description: "One-line STATUS reason." },
  },
};

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "sections", "buildSteps", "openQuestions", "reason"],
  properties: {
    status: { enum: ["DONE", "DONE_WITH_CONCERNS", "NEEDS_DECISION", "BLOCKED"] },
    sections: { type: "integer" },
    buildSteps: { type: "integer" },
    openQuestions: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
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
  required: ["verdict", "blockingFindings", "concerns"],
  properties: {
    verdict: { enum: ["approve", "request-changes", "block"] },
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
  },
};

const a = args || {};
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

/**
 * Selects the research model from pick-time facts. Research correctness is
 * load-bearing, so haiku is reserved for trivial, unambiguous work only.
 * @returns {string} Model alias.
 */
function researchModel() {
  const e = a.pickEstimate;
  if (hasRiskTag(a.tags) || a.thinDescription || (e != null && e >= 5)) return "opus";
  if (e != null && e <= 1 && ["docs", "chore"].includes(a.workType)) return "haiku";
  return "sonnet";
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

const head = `Target task: ${a.taskRef} (taskId ${a.taskId}).`;

// --- Research ---------------------------------------------------------------
phase("Research");
let brief = a.priorBrief;
let research = null;
if (shouldRun("research")) {
  const prompt =
    `${head}\nProject categories and tags: ${a.categories}; ${a.tagVocabulary}.` +
    (a.gateAnswers ? `\nOpen questions resolved by the user:\n${a.gateAnswers}` : "");
  research = await agent(prompt, {
    agentType: "piyaz:composer-researcher",
    model: researchModel(),
    effort: researchModel() === "haiku" ? "low" : "medium",
    schema: RESEARCH_SCHEMA,
    label: `research:${a.taskRef}`,
    phase: "Research",
  });
  if (!research) return blockedResult("research", "researcher returned no result");
  brief = research.brief;
  if (research.status === "NEEDS_DECISION") return gateResult("research", research);
  if (research.status === "BLOCKED") return blockedResult("research", research.reason);
}

const est = research ? research.estimate : (a.estimate != null ? a.estimate : a.pickEstimate);
const wt = research ? research.workType : a.workType;
const flags = research ? research.flags : a.flags || [];

// --- Plan -------------------------------------------------------------------
phase("Plan");
if (shouldRun("plan")) {
  const entryStatus = a.plannableOnly ? "draft" : a.mode === "single" ? "unknown" : "draft|planned";
  const prompt =
    `${head}\nEntry status: ${entryStatus}.\nResearch brief:\n${brief}` +
    (a.gateAnswers ? `\nOpen questions resolved by the user:\n${a.gateAnswers}` : "");
  const plan = await agent(prompt, {
    agentType: "piyaz:composer-planner",
    model: "opus",
    effort: est == null || est >= 8 || hasRiskTag(a.tags) ? "xhigh" : "high",
    schema: PLAN_SCHEMA,
    label: `plan:${a.taskRef}`,
    phase: "Plan",
  });
  if (!plan) return blockedResult("plan", "planner returned no result");
  if (plan.status === "NEEDS_DECISION") return gateResult("plan", plan, brief);
  if (plan.status === "BLOCKED") return blockedResult("plan", plan.reason);
}

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
    `${head} Plan is saved to Piyaz; fetch via piyaz_context depth='agent'. ` +
    "Claim the task, implement per the implementationPlan, open a PR, mark in_review per the Completion Protocol." +
    (a.priorFailure ? `\nPrior failed attempt:\n${a.priorFailure}` : "");
  const impl = await agent(prompt, {
    agentType: "piyaz:composer-implementer",
    model: implementModel(est, wt, flags),
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
let lastReview = null;
let ciState = "unknown";
let pendingFindings = a.resumeFrom === "fix" && a.fixFindings ? a.fixFindings : null;

while (true) {
  if (pendingFindings == null) {
    phase("CI gate");
    const ci = await agent(
      `Watch CI for pull request ${prUrl} and report status. Run exactly:\n` +
        `timeout 600 gh pr checks ${prUrl} --watch; echo "exit=$?"\n` +
        "Interpret the exit code: 0 means green; 8 or 124 means pending (checks still running or the watch timed out); any other non-zero means red, UNLESS the output says no checks are reported, which is none. " +
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
    lastReview = await agent(`${head} PR URL: ${prUrl}. Mode: composer-phase-4.${ciNote}`, {
      agentType: "piyaz:review",
      model: "opus",
      effort: "high",
      schema: VERDICT_SCHEMA,
      label: `review:${a.taskRef}`,
      phase: "Review",
    });
    if (!lastReview) return blockedResult("review", "reviewer returned no result");

    if (lastReview.verdict === "approve") break;
    if (lastReview.verdict === "block" || rotations >= 2) break;
    pendingFindings = formatFindings(lastReview.blockingFindings);
  }

  rotations++;
  log(`fix rotation ${rotations}/2 on ${a.taskRef}`);
  phase("Implement");
  const fix = await agent(
    `${head} Fix mode. PR: ${prUrl}. Address exactly these review findings, re-run verification, re-mark in_review:\n${pendingFindings}`,
    {
      agentType: "piyaz:composer-implementer",
      model: "opus",
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
