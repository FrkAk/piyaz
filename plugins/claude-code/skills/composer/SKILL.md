---
name: composer
description: >
  Use when the user types /piyaz:composer or /piyaz:composer <taskRef>, or
  asks composer to "run the next task", "ship the backlog", "compose
  through my ready queue", "loop through piyaz tasks", or otherwise
  requests end-to-end Piyaz task delivery (research → plan → implement →
  propagate, then pick the next task and repeat). Composer dispatches one
  fresh subagent per phase per task so each phase runs with a clean
  context window and a focused tool set; the orchestrator itself only
  picks tasks, hands off, and propagates. Do NOT invoke for one-off task
  lookups, status checks, refinement of one task by hand, or planning a
  single task interactively. Those flows belong to the piyaz skill and
  using composer for them adds latency without adding quality.
---

# Composer

Composer is a Piyaz task orchestrator. It picks the next ready task off the project's critical path, dispatches four subagents in sequence (research, plan, implement, review) to deliver it end-to-end with production-grade quality, propagates the result through the graph, and loops until the queue is empty or the user stops. Each subagent runs in a fresh context with a focused tool set; the main orchestrator stays clean across the whole session.

Composer is glue. The heavy lifting (task selection, refinement, the Completion Protocol, propagation) already lives in the `piyaz` skill (`plugins/claude-code/skills/piyaz/SKILL.md`). Composer reuses those flows verbatim rather than duplicating them.

## Invocation

Two modes, both surfaced as slash commands by the plugin:

- **`/piyaz:composer`**: backlog loop. The orchestrator picks the highest-value ready task each iteration and keeps going until a stop condition fires.
- **`/piyaz:composer <taskRef>`**: single-task mode (e.g. `/piyaz:composer ZIN-42`). Same pipeline applied to one task; the loop exits after the reviewer hands its verdict back to the orchestrator.

If the user typed `/piyaz:composer` with no argument, treat it as backlog mode. Anything else is single-task.

## The four subagents

Each subagent is a registered plugin agent. The orchestrator dispatches them via the Task tool by `subagent_type`. They have their own files; do not duplicate their logic here.

| Phase | `subagent_type` | File | Writes to Piyaz | Returns to orchestrator |
| --- | --- | --- | --- | --- |
| 1. Research | `piyaz:composer-researcher` | `plugins/claude-code/agents/composer-researcher.md` | Refinement fields on the target task (`description`, `acceptanceCriteria`, `tags`, `category`, `priority`, `estimate`, `decisions`); **never `status`, `implementationPlan`, `executionRecord`, or `files`** | A research brief: files to touch, existing patterns, library docs (with version-pin checks), security/perf considerations, project conventions, applied refinements with citations, open questions, flags |
| 2. Plan | `piyaz:composer-planner` | `plugins/claude-code/agents/composer-planner.md` | `implementationPlan` and `decisions`; `status='planned'` only on `draft → planned` transition; nothing else | Saves the unabridged `implementationPlan` to Piyaz; transitions the task `draft → planned` when entering at `draft`; returns a one-sentence confirmation |
| 3. Implement | `piyaz:composer-implementer` | `plugins/claude-code/agents/composer-implementer.md` | `status='in_progress'` (claim) and `status='in_review'` (with Completion Protocol payload: `executionRecord`, `decisions`, `files`, evaluated `acceptanceCriteria`); HOTL flips `in_review → done` post-approval, outside composer's loop | Writes code on a feature branch, runs tests/lint/typecheck, opens a PR, marks the task `in_review` in dispatched mode; returns the PR URL plus a one-sentence summary |
| 4. Review | `piyaz:review` | `plugins/claude-code/agents/review.md` | **Nothing.** Review is read-only over Piyaz; the verdict travels in the return message, not in any task field. The HOTL operator owns the `in_review → done` transition regardless of the verdict | A structured verdict (`approve` / `request-changes` / `block`) with file-cited reasoning across the security, performance, reliability, observability, and codebase-standards lenses; AC evaluation against the diff; plan-vs-diff drift; downstream impact list |

The contract is intentionally tight: the researcher applies refinements directly so the task row reflects ground truth before planning starts; the brief is the planner's *findings reference*, while the refined task itself is the planner's *input*. The planner's output also lands in Piyaz, so the implementer reads everything (refined description, refined ACs, the implementation plan, upstream decisions) from `piyaz_context depth='agent'` rather than receiving it from the orchestrator. The reviewer reads the same task row through `piyaz_context depth='review'`, which renders the implementation plan alongside the executionRecord and surfaces the PR link from `task_links`; the PR diff is the source of truth for what changed. Every dispatch payload stays small; the source of truth is one place: the task row.

## Piyaz operating context

The canonical piyaz rules load with this skill. Treat their content as part of your operating context; downstream citations (`conventions §1`, `artifacts §5`, etc.) refer to the loaded text.

@skills/piyaz/references/conventions.md
@skills/piyaz/references/artifacts.md
@skills/piyaz/references/lifecycle.md
@skills/piyaz/references/resilience.md

## Session bootstrap (first turn of every composer session)

Do these once, before the first iteration:

1. **Resolve the project.** `piyaz_project action='list'` → confirm with `action='select' projectId='...'`. If the user is in single-task mode, also run `piyaz_query type='search' query='<taskRef>'` to resolve the task UUID and surface its `state` hint.
2. **Read project meta.** `piyaz_query type='meta' projectId='...'`. Capture categories, tag vocabulary, and status counts in memory; pass them verbatim to each researcher dispatch so personas ground on the project taxonomy.
3. **Install the goal harness.** Generate the goal-condition string below and prompt the user to paste it into `/goal`. Composer cannot install `/goal` itself; the user has to type it. Emit the literal code-fence so the user can copy-paste:

   ````
   /goal piyaz_analyze type='ready' returns an empty set, OR composer reports three consecutive failed attempts on a task, OR the user types stop, OR (single-task mode) composer reports the target task marked done, OR (single-task mode) composer reports proposed rewrite denied on a task
   ````

   The `/goal` evaluator watches the transcript each turn and ends the session when one of the literal phrases above appears. Composer's job is to emit those literal phrases at the right moments (see *Stop conditions*).

4. **Confirm the harness fired.** Call `AskUserQuestion`: "Did `/goal` accept the harness?" with options yes / no. On yes, proceed to the loop. On no, emit a one-line warning ("Backlog mode without `/goal` has no automatic exit; type `stop` to halt the loop.") and proceed anyway. Composer cannot force the install; it can only refuse to start silently.

In backlog mode the harness is required; in single-task mode it is optional but recommended. Long single-task runs still benefit from the safety bound.

## Loop

```text
pick_task → dispatch researcher → dispatch planner → dispatch implementer → dispatch reviewer → propagate → loop
```

Per iteration the orchestrator runs:

1. **Pick the next task.**
   - Backlog mode: `piyaz_analyze type='ready' projectId='...'` ∩ `piyaz_analyze type='critical_path' projectId='...'`. Rank intersection by priority (`urgent > core > normal > backlog`), break ties by lowest `estimate`. Fall back to highest-priority `ready` task if the intersection is empty. Fall back to `piyaz_analyze type='plannable'` if `ready` itself is empty (route through researcher + planner first; nothing to implement yet).
   - Single-task mode: skip selection. The task is the one the user named. If its `state` is already `done` or `cancelled`, emit the done line (see *Stop conditions*) and exit.
   - Emit a one-paragraph **pick rationale** before claiming so the user can interject:
     > Next pick: `<taskRef>`. Priority=`<value>`, estimate=`<value>`, on critical path=`<yes|no>`. Reason: `<one sentence>`.

2. **Dispatch researcher.** One `Agent` call with `subagent_type='piyaz:composer-researcher'`. The prompt body opens with `Target task: <taskRef>` and includes the project's meta payload from bootstrap step 3 verbatim. The task stays at its current status (`draft` if picked from `plannable`, `planned` if picked from `ready`). Researchers do not claim, but they **do** refine: the researcher applies sharpening edits to `description`, `acceptanceCriteria`, `tags`, `category`, `priority`, `estimate`, and `decisions` based on what it finds in the codebase, in docs, and in its security/performance review. The task row evolves under your feet during this phase; that is intentional. Await the brief. Refinement writes are append-only and cannot fail destructively; the only way Phase 1 fails is if the researcher cannot ground its findings (returns `confidence < 0.6` or flags items in *Open questions*). In that case, surface those to the user and pause for an answer before continuing.

   **Post-researcher gates.** Two signals can divert the iteration before the planner runs. If the brief carries the `oversize-task` flag, defer to *Oversize handling* below. If the brief carries a `## Proposed rewrites` section, defer to *Proposed rewrites handling* below. Estimate refinements within the bounded scale (`1, 2, 3, 5, 8, 13`) are normal refinement and do not gate.

3. **Dispatch planner.** One `Agent` call with `subagent_type='piyaz:composer-planner'`. The prompt body includes `Target task: <taskRef>`, the task's current `status` so the planner knows whether it is writing a new plan or re-validating an existing one, the research brief verbatim, and a pointer to `piyaz_context depth='planning'` (the planner fetches it itself). The planner owns the `draft → planned` transition: when the task entered at `draft`, the planner writes the full `implementationPlan` and flips status to `planned` in one call; when the task entered at `planned`, the planner re-validates against the brief and either keeps the plan as-is without mutating the task (a silent re-validation is the correct trace) or refreshes the plan when the brief shows real drift. Verify the planner's write by polling `piyaz_context depth='summary' taskId='<id>'` once before advancing. If no plan is visible after a `draft` entry (or the planner reports failure), retry once with the failure message appended to the dispatch; on a second failure, treat the iteration as a failed attempt (see *Failure handling*).

4. **Dispatch implementer.** One `Agent` call with `subagent_type='piyaz:composer-implementer'`. The prompt body is short: `Target task: <taskRef>. Plan is saved to Piyaz; fetch via piyaz_context depth='agent'. Claim the task (planned → in_progress), implement per the implementationPlan, open a PR, mark the task `in_review` in dispatched mode per the Completion Protocol (the HOTL operator finalizes `in_review → done` after PR approval).` Await the implementer's return. The implementer owns the `planned → in_progress` claim, the `in_progress → in_review` completion, the PR creation, and the full Completion Protocol payload; the orchestrator writes none of these.

5. **Dispatch reviewer.** Once the implementer reports `in_review` and returns a PR URL, dispatch the review subagent. One `Agent` call with `subagent_type='piyaz:review'`. The prompt body is short: `Target task: <taskRef>. PR URL: <url>. Mode: composer-phase-4. Fetch the bundle via piyaz_context depth='review' taskId='<id>'.` Await the verdict. The reviewer is read-only over Piyaz; it does not flip status, write to `decisions`, or touch the working tree. Surface the verdict block verbatim to the user (HOTL) so they can act on it on GitHub. The orchestrator does not interpret `request-changes` or `block` as a retry signal; the HOTL operator owns the next move. A `block` verdict still falls through to propagation (the downstream graph still needs honest edges), but the iteration ends after propagation regardless of verdict.

6. **Propagate.** After the verdict is surfaced, run propagation per lifecycle §3: `piyaz_query type='edges' taskId='<id>'` then `piyaz_analyze type='downstream' taskId='<id>'`. Update or retire edge notes the implementer's work invalidated. Edge-note content follows artifacts §3: one to three short sentences, written as a brief to the downstream task's coding agent (what specifically does this task get from the target). No prose recaps. Surface newly-unblocked tasks in the next pick rationale.

7. **Loop.** Single-task mode: emit the done line (see *Stop conditions* item 4) and exit. Backlog mode: return to step 1.

### Oversize handling

`estimate` is bounded to Fibonacci values `1, 2, 3, 5, 8, 13` (artifacts §5); no task in Piyaz can carry an estimate above 13. Oversize is a *scope-detection* signal, not a numeric overflow: the researcher discovers during exploration that a task's true scope exceeds what `13` represents and raises the `oversize-task` flag in the brief.

Single checkpoint, post-researcher: if the brief carries `oversize-task`, surface the task ref and ask the user whether to dispatch `piyaz:decompose-task` to split or skip and pick the next ready task. Do not write a plan. Do not claim. Composer is not a decomposer; oversize routes out to the specialist agent before the planner runs.

Estimate refinements within the bounded scale (researcher bumps `5` to `8`, or `13` down to `8`) are normal. Needs evolve as exploration uncovers scope; the researcher updates `estimate` up or down within `[1, 13]` as warranted. That is refinement, not an oversize event.

### Proposed rewrites handling

The researcher may propose substantive rewrites of `description` or `acceptanceCriteria` rather than apply them directly (researcher prose: *Substantive rewrites: propose, do not apply*). When the brief carries a `## Proposed rewrites` section, do not advance to the planner. Surface each proposal to the user via `AskUserQuestion`: show the original value, the proposed value, and the researcher's one-line rationale; offer accept / deny per field.

On accept, apply the proposal via `piyaz_task action='update'` and re-dispatch the researcher with the rewritten task. The fresh research run reads the rewritten description and AC as ground truth, writes a new brief, and the planner runs against that brief. A rewrite the user accepted invalidates the prior brief; re-dispatching is what keeps the planner grounded in the post-rewrite scope.

On deny, end the iteration. Backlog mode: pick the next task; the denied task keeps its silently-applied refinements and stays at its current status. Single-task mode: emit `composer reports proposed rewrite denied on <taskRef>` to the transcript (matches the `/goal` clause) and exit.

Subsequent rewrite proposals on the re-dispatched run go through the same gate. The user can deny at any cycle to break out; there is no implicit cap.

### Phase entry and exit conditions

| Phase | Entry condition | Exit condition | Failure surface |
|---|---|---|---|
| Researcher | Task at `draft` or `planned`; pick rationale emitted | Brief returned, `confidence ≥ 0.6`, no `oversize-task` flag, no pending `## Proposed rewrites` (or all accepted and re-dispatched), refinements landed in Piyaz | `confidence < 0.6` pauses for user; oversize routes to *Oversize handling*; proposed rewrites route to *Proposed rewrites handling* |
| Planner | Task at `draft` (write new plan) or `planned` (re-validate); brief in dispatch prompt | `implementationPlan` visible via `piyaz_context depth='summary'`; status flipped to `planned` if entry was `draft` | No plan after one retry counts as a failed attempt per *Failure handling* |
| Implementer | Task at `planned`; plan saved to Piyaz | Status `in_review`, full Completion Protocol payload, PR URL returned (HOTL flips to `done` outside composer) | Tests/lint/typecheck red unrecoverable, or PR not opened, counts as a failed attempt; partial success (PR opened, `in_review` not marked) recovered per *Failure handling* |
| Reviewer | Task at `in_review`; PR URL visible on `task.links` (kind `pull_request`) or supplied in dispatch | Structured verdict returned (`approve` / `request-changes` / `block`); the verdict text is the iteration's hand-off artifact to HOTL; no Piyaz writes from this phase | Reviewer cannot reach `piyaz_context depth='review'`, or the bundle reports status mismatch and the dispatch is genuinely premature, counts as a failed attempt per *Failure handling*. A `block` or `request-changes` verdict is NOT a failure; it is the correct outcome of a careful review and surfaces straight to HOTL. |

**Recovering after orchestrator compaction.** Infer the current phase from the task's Piyaz status alone. `draft` with no plan: researcher pending. `draft` with plan present, or `planned`: planner done, implementer pending. `in_progress`: implementer pending or partial-success recovery (see *Failure handling*). `in_review`: implementer done; reviewer pending or already returned. When the transcript shows no verdict yet, dispatch the reviewer. When the verdict is in the transcript, advance to propagation. `done`: HOTL approved; iteration complete; advance to propagation if propagation has not yet run.

### The orchestrator does not write `status`

This is load-bearing and the most common way an orchestrator like composer goes wrong. **Every lifecycle transition belongs to a subagent**, never to the orchestrator:

- `draft → planned`: **planner**, when it saves the `implementationPlan` in one atomic update.
- `planned → in_progress`: **implementer**, as its claim before any code is touched.
- `in_progress → in_review`: **implementer**, with the full Completion Protocol payload (`executionRecord`, `decisions`, `files`, evaluated `acceptanceCriteria`) after the PR opens.
- `in_review → done`: **HOTL operator**, after PR approval/merge; never automatic and never written by composer or any subagent. The reviewer's verdict is advisory; HOTL still owns the transition.
- `* → cancelled`: never automatic; only triggered by an explicit user request, and even then routed through the appropriate subagent.

The orchestrator's only Piyaz writes per iteration are **edge updates during propagation** (step 6), and even those are conditional on what propagation discovers. Picking a task does not claim it. Dispatching a researcher does not claim it. Dispatching a reviewer does not flip status. The implementer is the only writer of `status='in_progress'`; the HOTL operator is the only writer of `status='done'`.

Violating this rule (e.g., claiming `in_progress` at pick time so "no other agent grabs the task") looks innocuous but breaks the piyaz contract in three ways: it forces a `draft` task into `in_progress` without a plan, it puts the task in `in_progress` while a read-only researcher runs (misleading anyone watching the project), and it suppresses the planner's `_hints` that fire on the legitimate `draft → planned` transition.

## Failure handling

A failed attempt is any of: implementer reports tests/lint/typecheck red and cannot self-recover; implementer returns without opening a PR; planner cannot save a plan after one retry; reviewer cannot reach `piyaz_context depth='review'` or the dispatch is premature (task not at `in_review`). A reviewer verdict of `request-changes` or `block` is NOT a failure; it is the correct outcome of a careful review and is surfaced to HOTL like any other verdict. On failure:

1. Do not write the failure to `decisions`. Per artifacts §1, `decisions` is CHOICE + WHY only; "attempt N failed" is process metadata and pollutes the field. Keep the failure summary in the orchestrator's own transcript (the user sees it directly there) and let the data layer's audit log carry the rest.
2. Leave the task at its current Piyaz status (do not auto-cancel; the task is not broken, the attempt was).
3. In backlog mode, move on to the next pick. In single-task mode, retry the iteration up to three total attempts (counting attempt 1). After three failures, emit `composer reports three consecutive failed attempts on <taskRef>` to the transcript (matches the `/goal` clause) and exit.

   **Why the asymmetry.** Backlog mode optimizes throughput across the queue; a stubborn task should not block other ready work. The failed task stays at `in_progress` for human triage. Single-task mode optimizes completion of one named task; retries are warranted because there is nothing else to fall through to.

Each retry dispatches the implementer fresh with the parent attempt's failure summary appended to the prompt; the researcher and planner are not re-run unless the failure clearly traces to a planning gap (e.g., the plan references a file that does not exist).

**Partial success: PR opened, `in_review` not marked.** If a retry's pre-flight finds the task at `in_progress` with an open PR matching the branch name pattern (`<type>/<taskRef-lowercased>-<title-slug>`), do not re-implement. Resume the Completion Protocol: re-evaluate acceptance criteria against the PR diff, populate `executionRecord` / `decisions` / `files`, mark `in_review`. The PR is the load-bearing artifact; the missing status write is recoverable. This is a single-attempt recovery; if it fails, count it toward the failure budget per rule 3.

## Stop conditions

The orchestrator emits one of these literal phrases to the transcript when the corresponding state holds. `/goal` matches against them and ends the session.

1. `piyaz_analyze type='ready' returns an empty set`: backlog drained.
2. `composer reports three consecutive failed attempts on <taskRef>`: same task failed three times in single-task mode (or after the orchestrator manually retried in backlog mode).
3. The user typed `stop` at any prompt: exit immediately after the current in-flight write finishes.
4. (Single-task mode only) `composer reports the target task marked done`: emitted right after step 7 reaches the loop exit (propagation done, verdict surfaced). The literal phrase contains `done` for `/goal` matching; the task itself is at `in_review` awaiting HOTL approval, not actually at `done`. Composer's iteration is what ends, not the task's lifecycle.
5. (Single-task mode only) `composer reports proposed rewrite denied on <taskRef>`: emitted right after the user denies a substantive rewrite proposal in single-task mode (see *Proposed rewrites handling*).

Do not invent new stop phrases. The `/goal` condition the user pastes during bootstrap matches these five verbatim; any drift breaks the harness.

## Reuse points from the piyaz skill

Composer is glue. It explicitly defers to the `piyaz` skill for:

- **Task selection.** `piyaz_analyze type='ready'` ∩ `type='critical_path'`, ranked by priority then estimate (see `plugins/claude-code/skills/piyaz/SKILL.md` § *What should I work on?*).
- **Refinement.** If the researcher's brief identifies vague acceptance criteria or a thin description, the planner applies refinements via `piyaz_task action='update'` with append semantics (see § *Refine a task* in the piyaz SKILL.md).
- **Planning.** Phase 2 saves the unabridged `implementationPlan` and transitions `draft → planned` exactly as § *Plan a draft task* specifies.
- **Implementation.** Phase 3 follows § *Implement a task* and the Completion Protocol (lifecycle §2). PR template detection, bracket form, body structure, `gh pr create` syntax all defer there. Composer adds only a conventional-commit title prefix when the project uses that format, and a `<type>/<taskRef>-<title-slug>` branch name; both live in `agents/composer-implementer.md`.
- **Review.** Phase 4 reads `piyaz_context depth='review'` and follows the five-lens persona in `agents/review.md`. The verdict shape (`approve` / `request-changes` / `block` plus per-lens prose, AC evaluation, plan-vs-diff drift, downstream impact) is the reviewer's contract with the orchestrator and with HOTL.
- **Propagation.** `piyaz_query type='edges'` then `piyaz_analyze type='downstream'` after every `in_review` transition (and every later `done`); update edge notes, retire stale edges.

If a flow exists in the piyaz skill, do not reinvent it inside a subagent. Cite the section by file path and anchor instead.

## What composer is not

- **Not a decomposer.** Oversize tasks route to `piyaz:decompose-task`. Composer asks first; never silently splits a task.
- **Not a refiner.** Composer's researcher proposes refinements via the brief; the planner applies them through the canonical `piyaz_task` update path. If the user wants pure refinement, they should run the `piyaz` skill directly.
- **Not the code reviewer itself.** Composer dispatches the `piyaz:review` subagent in Phase 4 to produce a structured verdict, but the orchestrator does not interpret the verdict beyond surfacing it. The PR is reviewed on GitHub like any other PR; the HOTL operator owns the final `in_review → done` transition outside composer's loop, regardless of whether the reviewer recommended `approve`, `request-changes`, or `block`.
- **Not a session-resilience layer.** Long runs that hit auto-compaction rely on `/goal` to bound the session and on `piyaz_query type='meta'` plus the per-task Piyaz status to re-acquire project state on resume; composer does not persist its own session file. The orchestrator's "current phase" is implicit, derived from transcript and task status; after compaction it reconstructs per the *Phase entry and exit conditions* table. For runs likely to span compaction, prefer single-task mode and re-invoke composer per task rather than running an unbounded backlog loop. See `skills/piyaz/references/resilience.md` for the broader resilience primitives.

## See also

- `plugins/claude-code/skills/piyaz/SKILL.md`: canonical Piyaz flows composer reuses.
- `skills/piyaz/references/conventions.md`: Iron Law of grounding (cite real code, real refs; never speculate).
- `skills/piyaz/references/artifacts.md`: title/description/AC quality (§1), tag dimensions (§2), categories (§4), oversize threshold (§5).
- `skills/piyaz/references/lifecycle.md`: status lifecycle (§1), Completion Protocol with PR template detection (§2), propagation (§3).
- `plugins/claude-code/agents/composer-researcher.md`, `composer-planner.md`, `composer-implementer.md`, `review.md`: the four subagent definitions composer dispatches.
- `plugins/claude-code/agents/decompose.md`: the oversize-delegation target.
