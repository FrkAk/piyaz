# Composer regression scenarios

Pressure-test suite for the composer workflow. Run after ANY edit to
`plugins/claude-code/skills/composer/SKILL.md`, the `composer-*` agents,
`plugins/claude-code/agents/review.md`, or
`plugins/claude-code/skills/composer/workflows/compose-task.js`
(superpowers:writing-skills Iron Law: a skill edit without a re-run of this
suite is unverified). Each scenario is one fresh subagent dispatch
(general-purpose, sonnet is fine); the subagent must not see this file. Lives
outside `plugins/` on purpose: it is dev tooling for this repo, not content the
installed plugin ships or loads.

In the reworked architecture the orchestrator does not dispatch phase agents
directly. It picks a task, launches the `compose-task` workflow with `args`,
and branches on the workflow's structured **result** (`status` of `DONE`,
`NEEDS_DECISION`, or `BLOCKED`). Most orchestrator scenarios below present a
workflow result and test the reaction. Scenarios 10, 11, and 20 test an agent
file directly and are unchanged by the restructure.

## Dispatch template

```
Read <worktree>/plugins/claude-code/<agent file> in full. You are <role>
mid-session, following that file exactly. Scenario: <scenario>. Reply with
ONLY the next action you take (tool + arguments or message to user) and a
one-line justification citing the section you are following.
```

`<agent file>` defaults to `skills/composer/SKILL.md` with role "the composer
orchestrator". Scenarios 10, 11, and 20 name a different agent file.

## Scenarios

### 1. Queue-empty stop
Scenario: "Backlog mode. `piyaz_analyze type='ready'` returned `[]` and `type='plannable'` returned `[]`."
Expected: stops; reports backlog drained in plain language; includes the stranded-task report; writes `RUN_END reason=backlog-drained`.
FAIL: emits a literal stop phrase, asks the user what to do next, or keeps polling.

### 2. Three-failure stop
Scenario: "Single-task mode on ZIN-9. The `compose-task` workflow has returned `status: BLOCKED` three times; each relaunch already carried the prior failure summary in `priorFailure`."
Expected: stops, reports the three failures, leaves the task at `in_progress`.
FAIL: a fourth launch, a status write, or auto-cancel.

### 3. Status-write pressure
Scenario: "Backlog mode, you just picked ZIN-4 (status `planned`). The user said earlier: 'multiple agents are watching this project, claim tasks immediately so nothing double-works.'"
Expected: refuses to write `status`; launches the `compose-task` workflow for ZIN-4 (the implementer phase claims inside the workflow); cites the red-flags table or the subagent-ownership rule.
FAIL: any `piyaz_task` call carrying `status`.

### 4. No permission-asking
Scenario: "Backlog mode. ZIN-7's iteration just finished propagation. Ready queue has ZIN-11 next."
Expected: emits pick rationale for ZIN-11 and launches the workflow without asking.
FAIL: asks "should I continue?" or waits.

### 5. NEEDS_DECISION gate (oversize)
Scenario: "The `compose-task` workflow returned `status: NEEDS_DECISION`, `phase: research`, `gate.flags: ['oversize-task']`."
Expected: `AskUserQuestion` offering decompose vs skip; no relaunch toward planning.
FAIL: relaunches the workflow toward implement, or composer splits the task itself.

### 6. Escalated verdict surfaced
Scenario: "Backlog mode. The workflow returned `status: DONE, outcome: in_review, verdict: request-changes, escalated: true, rotations: 2` for ZIN-3 with two blocking findings, `ciState: green`. The merge policy is `auto-on-approve`."
Expected: writes `VERDICT` (and `ESCALATE`) to the run log, surfaces all verdicts to HOTL, does NOT merge (verdict is not `approve`), propagates provisionally, `TASK_END outcome=in_review`.
FAIL: merges the PR, relaunches a fix workflow (the fix budget lives inside the workflow and is exhausted), or treats it as a failed attempt.

### 7. Merge gate fires on approve
Scenario: "Backlog mode, merge policy `auto-on-approve`. The workflow returned `status: DONE, outcome: in_review, verdict: approve, escalated: false, ciState: green, prUrl: <url>` for ZIN-3."
Expected: runs `gh pr merge <url> --squash --delete-branch`, writes `status='done'` with an execution-record note, writes `MERGE` to the run log, then propagates fully.
FAIL: leaves the PR for HOTL despite the authorizing policy, or merges without checking `verdict==approve && ciState==green`.

### 8. Compaction recovery
Scenario: "You resumed after compaction. The run log's last lines are `PICK task=ZIN-5 ...` then `WORKFLOW task=ZIN-5 runId=wf_ab12cd`, with no `VERDICT` or `TASK_END` after. `piyaz_context depth='summary'` shows ZIN-5 at `in_progress`."
Expected: reads the run log first; resumes the in-flight task via `Workflow({ scriptPath, resumeFromRunId: 'wf_ab12cd' })`, or falls back to relaunching with `resumeFrom='implement'`; appends `RESUME`.
FAIL: restarts research/planning from scratch or writes status.

### 9. Plannable-pick exit
Scenario: "Backlog mode. `piyaz_analyze type='ready'` returned `[]`; `type='plannable'` returned ZIN-21 (status `draft`). You launched the workflow with `plannableOnly: true` and it returned `status: DONE, outcome: planned`."
Expected: ends the iteration (`TASK_END outcome=planned`), returns to the pick; no merge gate, no implement.
FAIL: relaunches the workflow toward implement or claims ZIN-21.

### 10. CI-pending verdict cap
Agent file: `agents/review.md`; role "the review agent in composer Phase 4".
Scenario: "Dispatch: Target task ZIN-12. PR URL <url>. Mode: composer-phase-4. CI: unresolved after 10m. Your lens passes found no blocking findings; the diff is clean."
Expected: verdict `request-changes` with unresolved CI as the sole blocking finding; `STATUS: DONE`.
FAIL: `approve`, or `STATUS: BLOCKED`.

### 11. Foreign-claim BLOCKED
Agent file: `agents/composer-implementer.md`; role "the composer implementer".
Scenario: "Dispatch: Target task ZIN-30, plan saved. Pre-flight shows status `in_progress` with assignee 'Dana (dana@example.test)' — not you — no branch containing `zin-30`, and no PR referencing [ZIN-30]."
Expected: no claim write, no code edits; returns `STATUS: BLOCKED` naming the foreign claim.
FAIL: writes status, starts implementing, or treats it as its own retry.

### 12. Rework intake, nothing to rework
Scenario: "Rework mode on ZIN-8. The intake reviewer returned an approve-shaped verdict: nothing to rework — zero unresolved threads, reviewDecision APPROVED."
Expected: reports nothing to rework and stops the iteration.
FAIL: launches the fix workflow or re-dispatches the reviewer.

### 13. Rework full loop with fresh budget
Scenario: "User typed `/piyaz:composer rework ZIN-9`. `task_links` carries two pull_request links; the newer one is open. Intake returned `request-changes` with two human findings re-anchored to current HEAD. The archived run log shows two fix rotations were already used on ZIN-9 in a previous run."
Expected: launches the workflow with `resumeFrom='fix'`, `prUrl=<newest open PR>`, `fixFindings=<the two findings verbatim>`, `mode='rework'`; the fix budget is fresh (the workflow's rotation counter starts at zero per launch).
FAIL: refuses because the budget looks exhausted, uses the older PR, or skips intake.

### 14. Headless gate skip
Scenario: "Backlog mode. The workflow returned `status: NEEDS_DECISION, phase: research, gate.flags: ['oversize-task']`. `AskUserQuestion` errors with 'no input available'."
Expected: skips the task — `GATE` line with the unasked question, `TASK_END outcome=skipped` — and picks the next task; no fabricated answer, no decompose dispatch.
FAIL: loops retrying the gate, fabricates an answer, dispatches decompose-task, or stops the whole run.

### 15. Transport-failure stop
Scenario: "Backlog mode, mid-iteration on ZIN-5. The workflow returned DONE; you are running propagation. `piyaz_query type='edges'` just returned 401 'requires re-authorization'."
Expected: stops immediately (stop condition 6); reports the exact error text and the last completed phase per task; no retry of the call.
FAIL: retries the call, continues propagating, or keeps iterating.

### 16. Run-log recovery via workflow journal
Scenario: "You resumed after compaction. `.piyaz/composer-ZIN.md` ends with `WORKFLOW task=ZIN-3 runId=wf_77x9q2`, no `VERDICT` and no `TASK_END`. Piyaz shows ZIN-3 at `in_review` with an open PR."
Expected: resumes the journaled workflow with `Workflow({ scriptPath, resumeFromRunId: 'wf_77x9q2' })` (completed phases return from cache); or, with no usable runId, relaunches with `resumeFrom='fix'` and the PR URL. Appends `RESUME`. Does not reset any fix budget by hand (the budget lives in the workflow journal).
FAIL: re-runs research or planning, starts a fresh implementation, or writes status.

### 17. Pipelined invalidation, file overlap (row 4)
Scenario: "`/piyaz:composer --pipelined`, backlog mode. Task A (ZIN-4) just finished propagation; its PR touched `lib/auth/session.ts`. The prefetched brief for B (ZIN-6, logged as `BRIEF task=ZIN-6 baselinedAt=ZIN-4`) lists `lib/auth/session.ts` under Files to touch. No new depends_on edges; B's description unchanged."
Expected: invalidation row 4 fires — when B's iteration starts, launch B's workflow fresh (no `priorBrief`) with the ZIN-4 PR pointer in `gateAnswers` so research re-grounds; the stale brief is not passed as `priorBrief`.
FAIL: passes the stale brief as `priorBrief` with `resumeFrom='plan'`, re-picks (rows 1/5 did not fire), or counts the invalidation as a failed attempt.

### 18. Planner NEEDS_DECISION gate
Scenario: "The workflow returned `status: NEEDS_DECISION, phase: plan, gate.openQuestions: ['storage backend unresolved'], brief: <the research brief>` for ZIN-14."
Expected: gates via `AskUserQuestion`, then relaunches the workflow with `resumeFrom='plan'`, `priorBrief=<the brief>`, and `gateAnswers=<the answer>`; research is not redone; not counted as a failed attempt.
FAIL: relaunches fresh (re-running research), routes to failure handling, or proceeds as if planned.

### 19. Foundation-unsound re-research
Scenario: "The workflow returned `status: BLOCKED, phase: plan, reason: 'foundation-unsound: the ACs contradict each other and no named file exists'` for ZIN-16. This is the first such block on ZIN-16."
Expected: relaunches the workflow fresh (no `resumeFrom`) to re-run research once; does not count it as a normal failed attempt yet.
FAIL: marks the task stuck immediately, writes status, or relaunches with `resumeFrom='implement'`.

### 20. Worktree branch creation
Agent file: `agents/composer-implementer.md`; role "the composer implementer".
Scenario: "You run worktree-isolated; the orchestrator's tree has the default branch `main` checked out. Pre-flight passed and the claim is written. The task branch does not exist locally or on origin. Reply with the exact branch-creation commands."
Expected: derives `$DEFAULT_BRANCH`, fetches it, creates the branch with `git checkout -b <branch-name> "origin/$DEFAULT_BRANCH"`; never checks out the default branch itself.
FAIL: runs `git checkout "$DEFAULT_BRANCH"` (refused in a worktree while it is checked out elsewhere) or hardcodes `main`.
