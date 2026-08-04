# Piyaz lifecycle rules

How tasks move through state, what each state means, the Completion Protocol, and the propagation Iron Law. Read before any status transition, before marking a task done or cancelled, and after every status change.

## Contents

- §0 Project lifecycle: the four project phases and who flips them
- §1 Status lifecycle: what each state means, requires, and forbids
- §2 Completion Protocol: mode detection, required fields, PR-opening, checklist
- §3 Propagate after every change (Iron Law)

---

## 0. Project lifecycle

```
brainstorming → decomposing → active → archived
```

- `brainstorming`: scoping, no task graph yet. Brainstorm creates the project here and leaves it here.
- `decomposing`: the task graph is being created. Decompose and onboarding flip to it when task creation starts. Task and edge creation and refinement are the expected work; execution statuses come later.
- `active`: the graph is complete and the full task lifecycle (§1) runs. Decompose and onboarding flip to it once their graph validates. decompose-feature never touches project status.
- `archived`: read-only on the task surface, so `piyaz_create`, `piyaz_edit`, and `piyaz_link` fail while reads keep working. Archiving is a human or manage decision; unarchive with `piyaz_workspace action='update' status='active'`.

The server emits `_hints` when a write does not match the phase, such as flipping a task to `in_progress` while the project is `decomposing`. Act on them.

## 1. Status lifecycle

```
draft → planned → in_progress → in_review → done
                                            cancelled (terminal, reachable from any non-terminal)
```

| Status | Required fields | Forbidden fields | Trigger to leave |
|---|---|---|---|
| `draft` | `description`, `acceptanceCriteria` | `executionRecord`, `implementationPlan` | implementation plan saved → `planned` |
| `planned` | + `implementationPlan` (unabridged); all `depends_on` blockers `done` | `executionRecord` | someone claims via `piyaz_edit` → `in_progress` |
| `in_progress` | + one active worker | | work complete, record written, criteria evaluated, §2 run → `in_review` |
| `in_review` | + `executionRecord`, `decisions`, `files`, every criterion evaluated, `prUrl` when a PR was opened | | HOTL inspects the PR and flips → `done`, or back to `in_progress` for rework |
| `done` | inherited from `in_review` | | terminal |
| `cancelled` | + `executionRecord` (rationale and what was tried), `decisions` | | terminal |

Beyond the table:

- **`draft`** is scope captured, real but unbuilt, and cannot be coded directly. It reaches `planned` on an unabridged plan saved to the task; summaries do not count.
- **`planned`** means the plan exists and every `depends_on` blocker is itself `done`. Claim before starting work, which is what prevents two agents grabbing the same task.
- **`in_progress`** is exactly one engineer or agent, and should not span sessions. If work pauses, leave a note on the task or move it back to `planned`.
- **`in_review`** means the implementer finished, opened a PR, populated the full payload, and has tests, lint, and typecheck green. No agent self-promotes it to `done`; the HOTL operator owns that transition and needs no additional payload, since the implementer already populated everything. A reviewer requesting rework sends it back to `in_progress`.
- **`done`** is shipped and approved. Downstream tasks unblock when their `depends_on` chain reaches `done`; if one still looks blocked, run propagation (§3), since the chain may pass through a partially-done sub-graph.
- **`cancelled`** is transparent in the graph: passable but never satisfying. A dependent unblocks only when every active task reachable through cancelled middles is `done`. Cancelled tasks are excluded from progress percentages, critical-path calculations, and blocked listings.

---

## 2. Completion Protocol

Runs before transitioning a task to `in_review`, `done`, or `cancelled`. Copy this checklist and check items off; the subsections carry the rules per item.

```
Completion Protocol:
- [ ] Mode detected: dispatched (mark in_review directly) or direct (ask first) (§2.1)
- [ ] executionRecord: grounded, HOW it was built (what, mechanism, verification) (§2.2)
- [ ] decisions: CHOICE + WHY one-liners from the conversation (§2.2)
- [ ] files: every repo path touched; files=[] explicitly when none (§2.2)
- [ ] acceptanceCriteria: each item evaluated true/false against the work (§2.2)
- [ ] PR opened if the work changed code; template detected and filled (§2.3, §2.4)
- [ ] Non-code deliverables committed, linked, or recorded with a regeneration command (§2.2)
- [ ] prUrl passed on the in_review update when a PR exists (§2.2)
- [ ] Response _hints read; required-field hints cleared before continuing
- [ ] Propagation run (§3)
```

### 2.1. Detect mode by transcript

- **Dispatched:** your context shows you were invoked through the Task tool by a parent agent. Mark `in_review` directly with the full payload, which is the implementer's terminal write, and return to the parent with the task ref and a one-sentence summary. Do not ask.
- **Direct:** invoked by the user in a normal session. Ask "Ready to mark this `in_review`?" with a one-sentence preview of the record, and wait for explicit confirmation. An explicit user order ("mark EDR-5 done") is itself the confirmation, so do not re-ask. "Don't ask me anything" waives the question and never the fields' honesty: record only what you can cite, leave unevidenced criteria unchecked, and tell the user which fields still need input.
- **Uncertain:** default to asking. A spurious confirmation prompt is cheap; an unauthorized status change is expensive.

### 2.2. Populate the required fields

One `piyaz_edit` call carries the whole payload as ordered ops: `set executionRecord`, one `add` per decision, `set files`, `check` / `uncheck` each acceptance criterion by its id, `set prUrl` when a PR was opened (the backend upserts a `task_links` row with `kind='pull_request'` so the review subagent and the detail UI can resolve the PR), and the `set status` transition. The call is atomic, and the server returns `_hints` if anything is missing. Re-call with the additions before continuing.

For spec-review, docs, decision-only, or Piyaz-only refinement tasks that touched no repo files, `set files` with `value=[]` explicitly. Omitting the op leaves the prior value in place and the server's "missing files" hint will not clear. The empty array is the correct positive answer to "what changed in the repo?", not the absence of an answer.

Criterion ids come from `piyaz_get lens='working'` or `fields=['acceptanceCriteria']`. Evaluate each against the actual work. Wholesale `set` on a text field is never part of the protocol; the record accretes through `set executionRecord` on the first write and `append` after, with fix and rework rotations as the one exception ([specs/contracts.md](specs/contracts.md)). If you find yourself rewriting fields you did not author, stop.

The written shape of the record, its optional Deliverables section, and the decision-entry format all live in [specs/contracts.md](specs/contracts.md). Non-code deliverables must be reviewable: commit repo-resident artifacts in the PR, otherwise link them on the task or record the path or URL plus the exact regeneration command. Agent worktrees are ephemeral, so an uncommitted unlinked output is gone by review time.

### 2.3. Open a PR if the work changed code

Trigger: `files` is non-empty and the work was a real code change, meaning not research, not decision-only, not Piyaz-only refinement.

Template detection, the field-to-section mapping, the default body, and the `[<taskRef>]` bracket rule live in [specs/contracts.md](specs/contracts.md). Keep it concise: empty optional sections beat fabricated content, and a template question you cannot answer gets skipped rather than answered.

### 2.4. Skip the PR for these task types

The skip list (research, decision-only, Piyaz-only refinement, user-declined, and data or BA work without a code repo) lives in [specs/contracts.md](specs/contracts.md). When in doubt, ask the user before opening.

---

## 3. Propagate after every change (Iron Law)

```
A change that does not propagate did not happen.
```

The graph is Piyaz's value. Skip once and it lies: ready tasks that are not ready, blockers pointing at shipped work, and every future session picking the wrong next step.

After any status change or significant refinement:

1. `piyaz_map view='neighbors' task='<ref>'` for current relationships, both types, with notes.
2. `piyaz_map view='downstream' task='<ref>'` for who depends on this task.
3. For each downstream task, ask: do edge notes need updating to reflect new decisions? Are there new relationships this change revealed? Are there stale ones that no longer hold? Do downstream descriptions need updating based on what was decided?
4. Create, update, or remove edges through `piyaz_link`, keyed by source, target, and type.

**For cancellations**, edges to the cancelled task remain in place and cancellation is transitive-aware. The question to answer is whether there is a replacement. If a new task supersedes the cancelled one, rewire dependents to point at it. If the scope is genuinely abandoned, dependents may need cancelling too, or re-scoping so they no longer require the cancelled work.
