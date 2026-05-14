---
name: composer
description: >
  Use when the user types /mymir:composer or /mymir:composer <taskRef>, or
  asks composer to "run the next task", "ship the backlog", "compose
  through my ready queue", "loop through mymir tasks", or otherwise
  requests end-to-end Mymir task delivery (research → plan → implement →
  propagate, then pick the next task and repeat). Composer dispatches one
  fresh subagent per phase per task so each phase runs with a clean
  context window and a focused tool set; the orchestrator itself only
  picks tasks, hands off, and propagates. Do NOT invoke for one-off task
  lookups, status checks, refinement of one task by hand, or planning a
  single task interactively. Those flows belong to the mymir skill and
  using composer for them adds latency without adding quality.
---

# Composer

Composer is a Mymir task orchestrator. It picks the next ready task off the project's critical path, dispatches three subagents in sequence to deliver it end-to-end with production-grade quality, propagates the result through the graph, and loops until the queue is empty or the user stops. Each subagent runs in a fresh context with a focused tool set; the main orchestrator stays clean across the whole session.

Composer is glue. The heavy lifting (task selection, refinement, the Completion Protocol, propagation) already lives in the `mymir` skill (`plugins/claude-code/skills/mymir/SKILL.md`). Composer reuses those flows verbatim rather than duplicating them.

## Invocation

Two modes, both surfaced as slash commands by the plugin:

- **`/mymir:composer`**: backlog loop. The orchestrator picks the highest-value ready task each iteration and keeps going until a stop condition fires.
- **`/mymir:composer <taskRef>`**: single-task mode (e.g. `/mymir:composer ZIN-42`). Same pipeline applied to one task; the loop exits after the implementer marks it `done`.

If the user typed `/mymir:composer` with no argument, treat it as backlog mode. Anything else is single-task.

## The three subagents

Each subagent is a registered plugin agent. The orchestrator dispatches them via the `Agent` tool by `subagent_type`. They have their own files; do not duplicate their logic here.

| Phase | `subagent_type` | File | Writes to Mymir | Returns to orchestrator |
| --- | --- | --- | --- | --- |
| 1. Research | `mymir:composer-researcher` | `plugins/claude-code/agents/composer-researcher.md` | Refinement fields on the target task (`description`, `acceptanceCriteria`, `tags`, `category`, `priority`, `estimate`, `decisions`); **never `status`, `implementationPlan`, `executionRecord`, or `files`** | A research brief: files to touch, existing patterns, library docs (with version-pin checks), security/perf considerations, project conventions, applied refinements with citations, open questions, flags |
| 2. Plan | `mymir:composer-planner` | `plugins/claude-code/agents/composer-planner.md` | `implementationPlan` and `decisions`; `status='planned'` only on `draft → planned` transition; nothing else | Saves the unabridged `implementationPlan` to Mymir; transitions the task `draft → planned` when entering at `draft`; returns a one-sentence confirmation |
| 3. Implement | `mymir:composer-implementer` | `plugins/claude-code/agents/composer-implementer.md` | `status='in_progress'` (claim) and `status='done'` (with Completion Protocol payload: `executionRecord`, `decisions`, `files`, evaluated `acceptanceCriteria`) | Writes code on a feature branch, runs tests/lint/typecheck, opens a PR, marks the task `done` in dispatched mode; returns the PR URL plus a one-sentence summary |

The contract is intentionally tight: the researcher applies refinements directly so the task row reflects ground truth before planning starts; the brief is the planner's *findings reference*, while the refined task itself is the planner's *input*. The planner's output also lands in Mymir, so the implementer reads everything (refined description, refined ACs, the implementation plan, upstream decisions) from `mymir_context depth='agent'` rather than receiving it from the orchestrator. This keeps each dispatch payload small and the source of truth in one place: the task row.

## Mymir operating context

The canonical mymir rules load with this skill. Treat their content as part of your operating context; downstream citations (`conventions §1`, `artifacts §5`, etc.) refer to the loaded text.

@skills/mymir/references/conventions.md
@skills/mymir/references/artifacts.md
@skills/mymir/references/lifecycle.md
@skills/mymir/references/resilience.md

## Session bootstrap (first turn of every composer session)

Do these once, before the first iteration:

1. **Resolve the project.** `mymir_project action='list'` → confirm with `action='select' projectId='...'`. If the user is in single-task mode, also run `mymir_query type='search' query='<taskRef>'` to resolve the task UUID and surface its `state` hint.
2. **Read project meta.** `mymir_query type='meta' projectId='...'`. Capture categories, tag vocabulary, and status counts in memory; pass them verbatim to each researcher dispatch so personas ground on the project taxonomy.
3. **Install the goal harness.** Generate the goal-condition string below and prompt the user to paste it into `/goal`. Composer cannot install `/goal` itself; the user has to type it. Emit the literal code-fence so the user can copy-paste:

   ````
   /goal mymir_analyze type='ready' returns an empty set, OR composer reports three consecutive failed attempts on a task, OR the user types stop, OR (single-task mode) composer reports the target task marked done
   ````

   Then proceed. The `/goal` evaluator watches the transcript each turn and ends the session when one of the literal phrases above appears. Composer's job is to emit those literal phrases at the right moments (see *Stop conditions*).

In backlog mode the harness is required; in single-task mode it is optional but recommended. Long single-task runs still benefit from the safety bound.

## Loop

```
pick_task → dispatch researcher → dispatch planner → dispatch implementer → propagate → loop
```

Per iteration the orchestrator runs:

1. **Pick the next task.**
   - Backlog mode: `mymir_analyze type='ready' projectId='...'` ∩ `mymir_analyze type='critical_path' projectId='...'`. Rank intersection by priority (`urgent > core > normal > backlog`), break ties by lowest `estimate`. Fall back to highest-priority `ready` task if the intersection is empty. Fall back to `mymir_analyze type='plannable'` if `ready` itself is empty (route through researcher + planner first; nothing to implement yet).
   - Single-task mode: skip selection. The task is the one the user named. If its `state` is already `done` or `cancelled`, emit the done line (see *Stop conditions*) and exit.
   - **Oversize gate.** If the picked task has `estimate > 13` (per artifacts §5), do not run the pipeline on it. Surface the task ref and ask the user whether to dispatch `mymir:decompose` to split it first or skip it and pick the next ready task. Composer is not a decomposer.
   - Emit a one-paragraph **pick rationale** before claiming so the user can interject:
     > Next pick: `<taskRef>`. Priority=`<value>`, estimate=`<value>`, on critical path=`<yes|no>`. Reason: `<one sentence>`.

2. **Dispatch researcher.** One `Agent` call with `subagent_type='mymir:composer-researcher'`. The prompt body opens with `Target task: <taskRef>` and includes the project's meta payload from bootstrap step 3 verbatim. The task stays at its current status (`draft` if picked from `plannable`, `planned` if picked from `ready`). Researchers do not claim, but they **do** refine: the researcher applies sharpening edits to `description`, `acceptanceCriteria`, `tags`, `category`, `priority`, `estimate`, and `decisions` based on what it finds in the codebase, in docs, and in its security/performance review. The task row evolves under your feet during this phase; that is intentional. Await the brief. Refinement writes are append-only and cannot fail destructively; the only way Phase 1 fails is if the researcher cannot ground its findings (returns `confidence < 0.6` or flags items in *Open questions*). In that case, surface those to the user and pause for an answer before continuing.

   **Post-researcher oversize re-check.** After the researcher returns, re-read the task's `estimate` (the researcher may have refined it upward). If `estimate > 13` or the brief carries the `oversize-task` flag, do **not** advance to the planner. Branch back to the pick-time oversize gate: ask the user whether to dispatch `mymir:decompose` to split, or skip and pick the next ready task. Composer is not a decomposer; oversize tasks discovered during research route out of the pipeline before any plan is written.

3. **Dispatch planner.** One `Agent` call with `subagent_type='mymir:composer-planner'`. The prompt body includes `Target task: <taskRef>`, the task's current `status` so the planner knows whether it is writing a new plan or re-validating an existing one, the research brief verbatim, and a pointer to `mymir_context depth='planning'` (the planner fetches it itself). The planner owns the `draft → planned` transition: when the task entered at `draft`, the planner writes the full `implementationPlan` and flips status to `planned` in one call; when the task entered at `planned`, the planner re-validates against the brief and either keeps the plan as-is without mutating the task (a silent re-validation is the correct trace) or refreshes the plan when the brief shows real drift. Verify the planner's write by polling `mymir_context depth='summary' taskId='<id>'` once before advancing. If no plan is visible after a `draft` entry (or the planner reports failure), retry once with the failure message appended to the dispatch; on a second failure, treat the iteration as a failed attempt (see *Failure handling*).

4. **Dispatch implementer.** One `Agent` call with `subagent_type='mymir:composer-implementer'`. The prompt body is short: `Target task: <taskRef>. Plan is saved to Mymir; fetch via mymir_context depth='agent'. Claim the task (planned → in_progress), implement per the implementationPlan, open a PR, mark the task done in dispatched mode per the Completion Protocol.` Await the implementer's return. The implementer owns the `planned → in_progress` claim, the `in_progress → done` completion, the PR creation, and the full Completion Protocol payload; the orchestrator writes none of these.

5. **Propagate.** Once the implementer reports `done` and returns a PR URL, run propagation per lifecycle §3: `mymir_query type='edges' taskId='<id>'` then `mymir_analyze type='downstream' taskId='<id>'`. Update or retire edge notes the implementer's work invalidated. Edge-note content follows artifacts §3: one to three short sentences, written as a brief to the downstream task's coding agent (what specifically does this task get from the target). No prose recaps. Surface newly-unblocked tasks in the next pick rationale.

6. **Loop.** Single-task mode: emit the done line (see *Stop conditions* item 4) and exit. Backlog mode: return to step 1.

### The orchestrator does not write `status`

This is load-bearing and the most common way an orchestrator like composer goes wrong. **Every lifecycle transition belongs to a subagent**, never to the orchestrator:

- `draft → planned`: **planner**, when it saves the `implementationPlan` in one atomic update.
- `planned → in_progress`: **implementer**, as its claim before any code is touched.
- `in_progress → done`: **implementer**, with the full Completion Protocol payload (`executionRecord`, `decisions`, `files`, evaluated `acceptanceCriteria`).
- `* → cancelled`: never automatic; only triggered by an explicit user request, and even then routed through the appropriate subagent.

The orchestrator's only Mymir writes per iteration are **edge updates during propagation** (step 5), and even those are conditional on what propagation discovers. Picking a task does not claim it. Dispatching a researcher does not claim it. The implementer is the only writer of `status='in_progress'`.

Violating this rule (e.g., claiming `in_progress` at pick time so "no other agent grabs the task") looks innocuous but breaks the mymir contract in three ways: it forces a `draft` task into `in_progress` without a plan, it puts the task in `in_progress` while a read-only researcher runs (misleading anyone watching the project), and it suppresses the planner's `_hints` that fire on the legitimate `draft → planned` transition.

## Failure handling

A failed attempt is any of: implementer reports tests/lint/typecheck red and cannot self-recover; implementer returns without opening a PR; planner cannot save a plan after one retry. On failure:

1. Do not write the failure to `decisions`. Per artifacts §1, `decisions` is CHOICE + WHY only; "attempt N failed" is process metadata and pollutes the field. Keep the failure summary in the orchestrator's own transcript (the user sees it directly there) and let the data layer's audit log carry the rest.
2. Leave the task at its current Mymir status (do not auto-cancel; the task is not broken, the attempt was).
3. In backlog mode, move on to the next pick. In single-task mode, retry the iteration up to three total attempts (counting attempt 1). After three failures, emit `composer reports three consecutive failed attempts on <taskRef>` to the transcript (matches the `/goal` clause) and exit.

Each retry dispatches the implementer fresh with the parent attempt's failure summary appended to the prompt; the researcher and planner are not re-run unless the failure clearly traces to a planning gap (e.g., the plan references a file that does not exist).

## Stop conditions

The orchestrator emits one of these literal phrases to the transcript when the corresponding state holds. `/goal` matches against them and ends the session.

1. `mymir_analyze type='ready' returns an empty set`: backlog drained.
2. `composer reports three consecutive failed attempts on <taskRef>`: same task failed three times in single-task mode (or after the orchestrator manually retried in backlog mode).
3. The user typed `stop` at any prompt: exit immediately after the current in-flight write finishes.
4. (Single-task mode only) `composer reports the target task marked done`: emitted right after step 6's propagation completes.

Do not invent new stop phrases. The `/goal` condition the user pastes during bootstrap matches these four verbatim; any drift breaks the harness.

## Reuse points from the mymir skill

Composer is glue. It explicitly defers to the `mymir` skill for:

- **Task selection.** `mymir_analyze type='ready'` ∩ `type='critical_path'`, ranked by priority then estimate (see `plugins/claude-code/skills/mymir/SKILL.md` § *What should I work on?*).
- **Refinement.** If the researcher's brief identifies vague acceptance criteria or a thin description, the planner applies refinements via `mymir_task action='update'` with append semantics (see § *Refine a task* in the mymir SKILL.md).
- **Planning.** Phase 2 saves the unabridged `implementationPlan` and transitions `draft → planned` exactly as § *Plan a draft task* specifies.
- **Implementation.** Phase 3 follows § *Implement a task* and the Completion Protocol (lifecycle §2). PR template detection, bracket form, body structure, `gh pr create` syntax all defer there. Composer adds only a conventional-commit title prefix when the project uses that format, and a `<type>/<taskRef>-<title-slug>` branch name; both live in `agents/composer-implementer.md`.
- **Propagation.** `mymir_query type='edges'` then `mymir_analyze type='downstream'` after every `done` transition; update edge notes, retire stale edges.

If a flow exists in the mymir skill, do not reinvent it inside a subagent. Cite the section by file path and anchor instead.

## What composer is not

- **Not a decomposer.** Oversize tasks route to `mymir:decompose`. Composer asks first; never silently splits a task.
- **Not a refiner.** Composer's researcher proposes refinements via the brief; the planner applies them through the canonical `mymir_task` update path. If the user wants pure refinement, they should run the `mymir` skill directly.
- **Not a code reviewer.** The PR is reviewed on GitHub like any other PR. The implementer marks the task `done` in dispatched mode immediately after opening the PR; if the user wants a human gate before `done`, they should run single-task mode and watch the loop, or run the `mymir` skill manually instead.
- **Not a session-resilience layer.** Long runs that hit auto-compaction should rely on `/goal` to bound the session and `mymir_query type='meta'` to re-acquire project state on resume; composer does not persist its own session file.

## See also

- `plugins/claude-code/skills/mymir/SKILL.md`: canonical Mymir flows composer reuses.
- `skills/mymir/references/conventions.md`: Iron Law of grounding (cite real code, real refs; never speculate).
- `skills/mymir/references/artifacts.md`: title/description/AC quality (§1), tag dimensions (§2), categories (§4), oversize threshold (§5).
- `skills/mymir/references/lifecycle.md`: status lifecycle (§1), Completion Protocol with PR template detection (§2), propagation (§3).
- `plugins/claude-code/agents/composer-researcher.md`, `composer-planner.md`, `composer-implementer.md`: the three subagent definitions composer dispatches.
- `plugins/claude-code/agents/decompose.md`: the oversize-delegation target.
