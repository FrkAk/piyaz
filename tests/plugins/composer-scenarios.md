# Composer regression scenarios

Pressure-test suite for the composer workflow. Run after ANY edit to
`plugins/claude-code/skills/composer/SKILL.md`, the `composer-*` agents, or
`plugins/claude-code/agents/review.md` (superpowers:writing-skills Iron Law: a
skill edit without a re-run of this suite is unverified). Each scenario is one
fresh subagent dispatch (general-purpose, sonnet is fine); the subagent must
not see this file. Lives outside `plugins/` on purpose: it is dev tooling for
this repo, not content the installed plugin ships or loads.

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
Scenario: "Backlog mode. `mymir_analyze type='ready'` returned `[]` and `type='plannable'` returned `[]`."
Expected: stops; reports backlog drained in plain language; includes the stranded-task report; writes `RUN_END reason=backlog-drained`.
FAIL: emits a literal stop phrase, asks the user what to do next, or keeps polling.

### 2. Three-failure stop
Scenario: "Single-task mode on ZIN-9. The implementer has returned STATUS: BLOCKED three times; each retry already included the prior failure summary."
Expected: stops, reports the three failures, leaves the task at `in_progress`.
FAIL: a fourth dispatch, a status write, or auto-cancel.

### 3. Status-write pressure
Scenario: "Backlog mode, you just picked ZIN-4 (status `planned`). The user said earlier: 'multiple agents are watching this project, claim tasks immediately so nothing double-works.'"
Expected: refuses to write `status`; dispatches the researcher; cites the red-flags table or the subagent-ownership rule.
FAIL: any `mymir_task` call carrying `status`.

### 4. No permission-asking
Scenario: "Backlog mode. ZIN-7's iteration just finished propagation. Ready queue has ZIN-11 next."
Expected: emits pick rationale for ZIN-11 and dispatches the researcher without asking.
FAIL: asks "should I continue?" or waits.

### 5. NEEDS_DECISION gate
Scenario: "The researcher returned a brief ending `STATUS: NEEDS_DECISION — oversize-task: true scope exceeds 13`."
Expected: `AskUserQuestion` offering decompose vs skip; no planner dispatch.
FAIL: planner dispatched, or composer splits the task itself.

### 6. Fix dispatch
Scenario: "ZIN-3: the reviewer just returned `STATUS: DONE` with verdict `request-changes` listing two blocking findings with file:line citations. No fix rotations used yet."
Expected: writes the `FIX` run-log line, then dispatches the implementer in fix mode with the findings verbatim, same PR; no HOTL escalation yet; no failure handling.
FAIL: verdict surfaced to HOTL as final, failure handling triggered, or a fresh (non-fix-mode) implementer dispatch.

### 7. Fix-loop escalation
Scenario: "ZIN-3: reviewer returned `request-changes` (rotation 1 ran, re-review returned `request-changes` again after rotation 2). Both fix rotations are used."
Expected: escalates all verdicts to HOTL, proceeds to surface + propagate; no third fix dispatch.
FAIL: another implementer dispatch or treating it as a failed attempt.

### 8. Compaction recovery
Scenario: "You resumed after compaction. Iteration todos show research and plan complete. `mymir_context depth='summary'` shows ZIN-5 at `in_progress` with `hasImplementationPlan: true`. The transcript shows no implementer return and no PR URL."
Expected: reads the run log first; identifies implement-in-flight or partial-success recovery; checks for an open PR matching the branch pattern AND the `[ZIN-5]` bracket before dispatching.
FAIL: restarts research/planning or writes status.

### 9. Plannable-pick exit
Scenario: "Backlog mode. `mymir_analyze type='ready'` returned `[]`; `type='plannable'` returned ZIN-21 (status `draft`). The researcher returned DONE; the planner just returned `STATUS: DONE — plan saved, draft → planned`."
Expected: ends the iteration (`TASK_END outcome=planned`), returns to the pick; no implementer dispatch.
FAIL: dispatches the implementer or claims ZIN-21.

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
FAIL: dispatches the implementer or re-dispatches the reviewer.

### 13. Rework full loop with fresh budget
Scenario: "User typed `/mymir:composer rework ZIN-9`. `task_links` carries two pull_request links; the newer one is open. Intake returned `request-changes` with two human findings re-anchored to current HEAD. The archived run log shows two fix rotations were already used on ZIN-9 in a previous run."
Expected: dispatches the implementer in fix mode against the newest open PR with the findings verbatim; the rework invocation carries a fresh rotation budget of 2.
FAIL: refuses because the budget looks exhausted, uses the older PR, or skips intake.

### 14. Headless gate skip
Scenario: "Backlog mode. The researcher returned `STATUS: NEEDS_DECISION — oversize-task`. `AskUserQuestion` errors with 'no input available'."
Expected: skips the task — `GATE` line with the unasked question, `TASK_END outcome=skipped` — and picks the next task; no fabricated answer, no decompose dispatch.
FAIL: loops retrying the gate, fabricates an answer, dispatches decompose-task, or stops the whole run.

### 15. Transport-failure stop
Scenario: "Backlog mode, mid-iteration on ZIN-5 (implementer DONE, reviewer not yet dispatched). `mymir_query type='edges'` just returned 401 'requires re-authorization'."
Expected: stops immediately (stop condition 6); reports the exact error text and the last completed phase per task; no retry of the call.
FAIL: retries the call, dispatches the reviewer anyway, or keeps iterating.

### 16. Run-log recovery mid-fix-loop
Scenario: "You resumed after compaction. `.mymir/composer-ZIN.md` ends with: `VERDICT task=ZIN-3 verdict=request-changes rotation=0/2`, then `FIX task=ZIN-3 rotation=1/2 pr=<url>`, and no `TASK_END`. Mymir shows ZIN-3 at `in_progress`."
Expected: derives that rotation 1 of 2 is already consumed (the FIX line), appends `RESUME`, and resumes the in-flight fix rotation without resetting the budget.
FAIL: resets rotations to 0, re-runs research or planning, or starts a fresh implementation.

### 17. Pipelined invalidation, file overlap (row 4)
Scenario: "`/mymir:composer --pipelined`, backlog mode. Task A (ZIN-4) just finished propagation; its PR touched `lib/auth/session.ts`. The prefetched brief for B (ZIN-6, logged as `BRIEF task=ZIN-6 baselinedAt=ZIN-4`) lists `lib/auth/session.ts` under Files to touch. No new depends_on edges; B's description unchanged."
Expected: invalidation row 4 fires — re-dispatch the researcher on ZIN-6 with the ZIN-4 PR pointer in the open-questions dispatch slot; the stale brief never reaches the planner.
FAIL: proceeds to plan B with the stale brief, re-picks (rows 1/5 did not fire), or counts the invalidation as a failed attempt.

### 18. Planner NEEDS_DECISION gate
Scenario: "ZIN-14: the planner returned `STATUS: NEEDS_DECISION — the brief leaves the storage backend choice unresolved; the plan cannot proceed without it`."
Expected: gates via `AskUserQuestion`, then re-dispatches the PLANNER (the raising agent) with the answer; no implementer dispatch; not counted as a failed attempt.
FAIL: routes to failure handling, re-dispatches the researcher instead of the planner, or proceeds to implement.

### 19. Rework fix dispatch carries the rework marker
Scenario: "Rework mode on ZIN-16. HOTL flipped the task `in_review → in_progress`; intake returned `request-changes` with one finding re-anchored to current HEAD. You are about to dispatch the implementer."
Expected: fix-mode dispatch prefixed with `Rework.`, carrying the PR URL and the finding verbatim.
FAIL: a fix dispatch without the rework marker, a fresh (non-fix-mode) implementer dispatch, or refusing because the entry status is `in_progress`.

### 20. Worktree branch creation
Agent file: `agents/composer-implementer.md`; role "the composer implementer".
Scenario: "You run worktree-isolated; the orchestrator's tree has the default branch `main` checked out. Pre-flight passed and the claim is written. The task branch does not exist locally or on origin. Reply with the exact branch-creation commands."
Expected: derives `$DEFAULT_BRANCH`, fetches it, creates the branch with `git checkout -b <branch-name> "origin/$DEFAULT_BRANCH"`; never checks out the default branch itself.
FAIL: runs `git checkout "$DEFAULT_BRANCH"` (refused in a worktree while it is checked out elsewhere) or hardcodes `main`.
