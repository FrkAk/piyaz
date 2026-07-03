# Piyaz lifecycle rules

How tasks move through state, what each state means, the Completion Protocol (with PR-opening), and the propagation Iron Law.

Agents read this file before any status transition, before marking a task done or cancelled, and after every status change to propagate.

> Sections of this file are mirrored by the composer phase extracts in the claude-code plugin (`plugins/claude-code/skills/composer/references/`); when you edit a mirrored section, update those extracts and bump the pin in their `sources.json`.

## Contents

- §1 Status lifecycle: what each state means, requires, and forbids
- §2 Completion Protocol: mode detection, required fields, PR-opening, checklist
- §3 Propagate after every change (Iron Law)

---

## 1. Status lifecycle

```
draft → planned → in_progress → in_review → done
                                            cancelled (terminal, reachable from any non-terminal)
```

### Summary

| Status | Required fields | Forbidden fields | Trigger to leave |
|---|---|---|---|
| `draft` | `description`, `acceptanceCriteria` | `executionRecord`, `implementationPlan` | implementation plan saved → `planned` |
| `planned` | + `implementationPlan` (unabridged); all `depends_on` blockers `done` | `executionRecord` | someone claims via `piyaz_edit` (`set status='in_progress'`) → `in_progress` |
| `in_progress` | + active worker (one only) | — | work complete + record + ACs + Completion Protocol §2 run → `in_review` |
| `in_review` | + `executionRecord`, `decisions`, `files`, every AC evaluated, `prUrl` (optional sugar, set when a PR was opened; backend upserts a `task_links` row with `kind='pull_request'`) | — | HOTL operator inspects PR and flips → `done` (or back to `in_progress` for rework) |
| `done` | (inherited from `in_review`) | — | terminal |
| `cancelled` | + `executionRecord` (rationale + what was tried), `decisions` | — | terminal |

### `draft`

- **What it means.** Scope captured. The task is real but unbuilt.
- **Cannot:** be coded directly. Needs planning first.
- **Transitions to `planned`:** when an implementation plan is written and saved on the task. The plan must be unabridged. Do not save summaries.

### `planned`

- **What it means.** Implementation plan is written. All `depends_on` blockers are themselves `done`. Ready for someone to claim and code.
- **Transitions to `in_progress`:** when someone explicitly claims via `piyaz_edit task='<ref>' operations=[{op:'set', field:'status', value:'in_progress'}]`. Claim BEFORE starting work; this prevents two agents from grabbing the same task.

### `in_progress`

- **What it means.** Active implementation. Exactly one engineer or agent is working on it.
- **Constraint:** should not span sessions. If work pauses, leave a note in the task or move it back to `planned`.
- **Transitions to `in_review`:** when implementation is complete, `executionRecord` / `decisions` / `files` are populated, acceptance criteria are evaluated, and the Completion Protocol (§2) has run.

### `in_review`

- **What it means.** Implementer subagent has finished the work, opened a PR, and populated the full Completion Protocol payload (`executionRecord`, `decisions`, `files`, evaluated `acceptanceCriteria`). Tests, lint, and typecheck are green. Awaiting human review on the PR.
- **Cannot:** be self-promoted to `done` by any agent. The HOTL operator owns the `in_review → done` transition.
- **Transitions to `done`:** when the PR is approved/merged and the operator updates status. No additional payload is required; the implementer already populated everything.
- **Transitions back to `in_progress`:** when the reviewer requests rework. The implementer or a follow-up worker picks the task up again from `in_progress`.

### `done` (terminal)

- **What it means.** Shipped and approved. The PR is merged (or otherwise accepted) and the HOTL operator has flipped the task from `in_review`. Carries the full record: `executionRecord` (3-5 sentences on what was built), `decisions` (one-liner per choice), `files` (every path touched), `acceptanceCriteria` with each item evaluated (`checked: true` or `false`).
- **Effect on graph:** downstream tasks unblock when their `depends_on` chain reaches `done`. If a downstream still appears blocked, run propagation (§3); the chain may pass through a partially-done sub-graph.

### `cancelled` (terminal, reachable from any non-terminal state)

- **What it means.** Abandoned work. Carries `executionRecord` (rationale: why abandoned, what was tried) and `decisions` (anything learned).
- **Transparent in the dependency graph.** Passable but never satisfying. A dependent only becomes unblocked when every active task reachable through cancelled middles is `done`.
- **Excluded from:** progress percentages, critical-path calculations, blocked listings.

---

## 2. Completion Protocol

Before transitioning a task to `in_review`, `done`, or `cancelled`. Copy this checklist and check items off as you complete them; the subsections below carry the full rules per item:

```
Completion Protocol:
- [ ] Mode detected: dispatched (mark in_review directly) or direct (ask first) (§2.1)
- [ ] executionRecord: 3-5 sentences, grounded, HOW it was built (§2.2)
- [ ] decisions: CHOICE + WHY one-liners from the conversation (§2.2)
- [ ] files: every repo path touched; files=[] explicitly when none (§2.2)
- [ ] acceptanceCriteria: each item evaluated true/false against the work (§2.2)
- [ ] PR opened if the work changed code; template detected and filled (§2.3, §2.4)
- [ ] prUrl passed on the in_review update when a PR exists (§2.2)
- [ ] Response _hints read; required-field hints cleared before continuing
- [ ] Propagation run (§3)
```

### 2.1. Detect mode by transcript

- **Dispatched mode**: your context shows you were invoked via the Task tool by a parent agent. Mark `in_review` directly with the full payload (the implementer's terminal write); the HOTL operator finalizes to `done`. Return to the parent with the task ref and a one-sentence summary. Do not ask.
- **Direct mode**: invoked by the user in a normal session. Ask "Ready to mark this `in_review`?" with a one-sentence executionRecord preview. Wait for explicit confirmation; the HOTL operator finalizes to `done` after PR approval. An explicit user order ("mark EDR-5 done") is itself the confirmation; do not re-ask. "Don't ask me anything" waives the question, never the required fields' honesty: record only what you can cite, leave unevidenced ACs unchecked, and tell the user which fields still need input.
- **Uncertain**: default to asking. A spurious confirmation prompt is cheap; an unauthorized status change is expensive.

### 2.2. Populate the required fields

One `piyaz_edit` call carries the whole payload as ordered ops: `set executionRecord`, one `add` per decision, `set files`, `check`/`uncheck` each acceptance criterion by its id, `set prUrl` when a PR was opened (backend upserts a `task_links` row with `kind='pull_request'` so the review subagent and detail UI can resolve the PR), and the `set status` transition. The call is atomic; the MCP server returns `_hints` if anything is missing. Re-call with the additions before continuing.

For pure spec-review / docs / decision-only / Piyaz-only refinement tasks that touched no repo files, `set files` with `value=[]` explicitly. Omitting the op leaves the prior value in place and the server's "missing files" hint will not clear. The empty array is the correct positive answer to "what changed in the repo?", not the absence of an answer.

Criterion ids come from `piyaz_get lens='working'` or `fields=['acceptanceCriteria']`; evaluate each against the actual work. Wholesale `set` on text fields is never part of the Completion Protocol; the record accretes via `set executionRecord` (first write) or `append` (adding to prior work). If you find yourself rewriting fields you did not author, stop and re-read the red flags in SKILL.md.

### 2.3. Open a PR if the work changed code

If `files` is non-empty AND the work was a real code change (not research, not decision-only, not Piyaz-only refinement):

**Detect a PR template** in the repo at one of these paths (or similar):

- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/pull_request_template.md`
- `.github/PULL_REQUEST_TEMPLATE/<name>.md`
- `docs/pull_request_template.md`

**If a template exists**: fill it. Map task fields onto template sections only where they fit. Leave a section blank rather than invent content. Common mappings:

- Linked issue / linked task: include the `taskRef` in `[BRACKETS]` (e.g. `[LSQ-38]`). Bracket form triggers Piyaz PR-status tracking; use it for the ONE primary task this PR builds. Reference any related tasks elsewhere as plain links (no brackets). Add `Closes #N` on its own line if a GitHub issue is being resolved.
- Summary section: 2 to 3 sentences from `executionRecord`.
- Test plan / verification section: the `acceptanceCriteria` items that are checked.
- Decisions or notes-for-reviewer section if present: relevant entries from `decisions`.

**If no template exists**: use this concise default.

```markdown
## Summary

**Task Reference**: [PREFIX-N]
<!-- The ONE primary task this PR builds. Brackets trigger Piyaz
     PR-status tracking. Use them only here. Reference any related
     tasks elsewhere as plain links (no brackets). -->

<!-- What does this PR change and why? If it resolves a GitHub issue,
     add "Closes #N" on its own line. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Documentation

## Testing

- [ ] Tested locally with `<command>`
- [ ] Linting and formatting pass (`<command>`)
- [ ] Type or build check passes (`<command>`)

## Notes for reviewer

<!-- Anything non-obvious: tradeoffs, follow-up work, alternatives
     considered. Skip if there is nothing useful to add. -->
```

Open the PR with `gh pr create --title '<task title>' --body "$(cat <<'EOF' ... EOF)"`.

**Always concise.** Do not pad sections to look thorough. Empty optional sections beat fabricated content. If the template has prompt questions you cannot answer, skip them rather than make answers up.

### 2.4. Skip the PR for these task types

- Research / investigation tasks (no code change).
- Decision-only tasks.
- Pure-Piyaz refinement tasks (no repo changes).
- Tasks the user explicitly said "no PR" on.
- Data and BA work without a code repo (a Looker dashboard tweak applied via the Looker UI, a Tableau workbook published from Desktop, a metric definition signed off in a doc, an ad-hoc SQL analysis attached to a ticket, a BRD update in Confluence). In these cases the deliverable lives outside git; record the artifact link or path in `executionRecord` and `files` instead of opening a PR. When the data work IS in a git repo (a dbt project, a SQL repo, a notebook collection under version control), open a PR per the standard rules above.

When in doubt, ask the user before opening.

---

## 3. Propagate after every change (Iron Law)

```
A change that does not propagate did not happen.
```

The graph is Piyaz's value. Skip once and it lies: ready tasks that aren't ready, blockers pointing at shipped work, every future session picking the wrong next step.

After any status change or significant refinement:

1. `piyaz_map view='neighbors' task='<ref>'`. Current relationships, both types, with notes.
2. `piyaz_map view='downstream' task='<ref>'`. Who depends on this task.
3. For each downstream task, evaluate:
   - Do edge notes need updating to reflect new decisions?
   - Are there NEW relationships revealed by this change?
   - Are there STALE relationships that no longer hold?
   - Do downstream descriptions need updating based on the decisions made?
4. Create, update, or remove edges as needed via `piyaz_link` (keyed by source+target+type).

**For cancellations specifically:**

- Edges to a cancelled task remain in place. Cancellation is transitive-aware.
- The question to answer is: **is there a replacement?**
  - **Yes** (a new task supersedes the cancelled one): rewire dependents to point at the replacement.
  - **No** (the scope is genuinely abandoned): dependents may need to be cancelled too, or re-scoped to no longer require the cancelled work.

Skipping propagation is how dependency graphs go stale. Stale graphs make Piyaz useless.
