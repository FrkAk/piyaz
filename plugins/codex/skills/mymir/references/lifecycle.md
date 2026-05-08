# Mymir lifecycle rules

How tasks move through state, what each state means, the Completion Protocol (with PR-opening), and the propagation Iron Law.

Agents read this file before any status transition, before marking a task done or cancelled, and after every status change to propagate.

---

## 1. Status lifecycle

```
draft → planned → in_progress → done
                                cancelled (terminal, reachable from any non-terminal)
```

### Summary

| Status | Required fields | Forbidden fields | Trigger to leave |
|---|---|---|---|
| `draft` | `description`, `acceptanceCriteria` | `executionRecord`, `implementationPlan` | implementation plan saved → `planned` |
| `planned` | + `implementationPlan` (unabridged); all `depends_on` blockers `done` | `executionRecord` | someone claims via `action='update' status='in_progress'` → `in_progress` |
| `in_progress` | + active worker (one only) | — | work complete + record + ACs + Completion Protocol §2 run → `done` |
| `done` | + `executionRecord` (3-5 sentences), `decisions`, `files`, every AC `checked: true|false` | — | terminal |
| `cancelled` | + `executionRecord` (rationale + what was tried), `decisions` | — | terminal |

### `draft`

- **What it means.** Scope captured. The task is real but unbuilt.
- **Cannot:** be coded directly. Needs planning first.
- **Transitions to `planned`:** when an implementation plan is written and saved on the task. The plan must be unabridged. Do not save summaries.

### `planned`

- **What it means.** Implementation plan is written. All `depends_on` blockers are themselves `done`. Ready for someone to claim and code.
- **Transitions to `in_progress`:** when someone explicitly claims via `mymir_task action='update' status='in_progress'`. Claim BEFORE starting work; this prevents two agents from grabbing the same task.

### `in_progress`

- **What it means.** Active implementation. Exactly one engineer or agent is working on it.
- **Constraint:** should not span sessions. If work pauses, leave a note in the task or move it back to `planned`.
- **Transitions to `done`:** when implementation is complete, `executionRecord` / `decisions` / `files` are populated, acceptance criteria are evaluated, and the Completion Protocol (§2) has run.

### `done` (terminal)

- **What it means.** Shipped. Carries the full record: `executionRecord` (3-5 sentences on what was built), `decisions` (one-liner per choice), `files` (every path touched), `acceptanceCriteria` with each item evaluated (`checked: true` or `false`).
- **Effect on graph:** downstream tasks unblock when their `depends_on` chain reaches `done`. If a downstream still appears blocked, run propagation (§3); the chain may pass through a partially-done sub-graph.

### `cancelled` (terminal, reachable from any non-terminal state)

- **What it means.** Abandoned work. Carries `executionRecord` (rationale: why abandoned, what was tried) and `decisions` (anything learned).
- **Transparent in the dependency graph.** Passable but never satisfying. A dependent only becomes ready when every active task reachable through cancelled middles is `done`.
- **Excluded from:** progress percentages, critical-path calculations, blocked listings.

---

## 2. Completion Protocol

Before transitioning a task to `done` or `cancelled`:

### 2.1. Detect mode by transcript

- **Dispatched mode**: your context shows you were invoked via the Task tool by a parent agent. Mark done directly with the full payload. Return to the parent with the task ref and a one-sentence summary. Do not ask.
- **Direct mode**: invoked by the user in a normal session. Ask "Ready to mark this done?" with a one-sentence executionRecord preview. Wait for explicit confirmation.
- **Uncertain**: default to asking. A spurious confirmation prompt is cheap; an unauthorized status change is expensive.

### 2.2. Populate the required fields

`executionRecord`, `decisions`, `files`, `acceptanceCriteria`. The MCP server returns `_hints` if any are missing. Re-call with the additions before continuing.

For pure spec-review / docs / decision-only / Mymir-only refinement tasks that touched no repo files, pass `files=[]` explicitly. Omitting the field leaves the prior value in place and the server's "missing files" hint will not clear. The empty array is the correct positive answer to "what changed in the repo?", not the absence of an answer.

### 2.3. Open a PR if the work changed code

If `files` is non-empty AND the work was a real code change (not research, not decision-only, not Mymir-only refinement):

**Detect a PR template** in the repo at one of these paths (or similar):

- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/pull_request_template.md`
- `.github/PULL_REQUEST_TEMPLATE/<name>.md`
- `docs/pull_request_template.md`

**If a template exists**: fill it. Map task fields onto template sections only where they fit. Leave a section blank rather than invent content. Common mappings:

- Linked issue / linked task: include the `taskRef` in `[BRACKETS]` (e.g. `[MYMR-83]`). Bracket form triggers Mymir PR-status tracking; use it for the ONE primary task this PR builds. Reference any related tasks elsewhere as plain links (no brackets). Add `Closes #N` on its own line if a GitHub issue is being resolved.
- Summary section: 2 to 3 sentences from `executionRecord`.
- Test plan / verification section: the `acceptanceCriteria` items that are checked.
- Decisions or notes-for-reviewer section if present: relevant entries from `decisions`.

**If no template exists**: use this concise default.

```markdown
## Summary

**Task Reference**: [MYMR-XXX]
<!-- The ONE primary task this PR builds. Brackets trigger Mymir
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
- Pure-Mymir refinement tasks (no repo changes).
- Tasks the user explicitly said "no PR" on.
- Data and BA work without a code repo (a Looker dashboard tweak applied via the Looker UI, a Tableau workbook published from Desktop, a metric definition signed off in a doc, an ad-hoc SQL analysis attached to a ticket, a BRD update in Confluence). In these cases the deliverable lives outside git; record the artifact link or path in `executionRecord` and `files` instead of opening a PR. When the data work IS in a git repo (a dbt project, a SQL repo, a notebook collection under version control), open a PR per the standard rules above.

When in doubt, ask the user before opening.

---

## 3. Propagate after every change (Iron Law)

After any status change or significant refinement:

1. `mymir_query type='edges'` on the changed task. Current relationships.
2. `mymir_analyze type='downstream'`. Who depends on this task.
3. For each downstream task, evaluate:
   - Do edge notes need updating to reflect new decisions?
   - Are there NEW relationships revealed by this change?
   - Are there STALE relationships that no longer hold?
   - Do downstream descriptions need updating based on the decisions made?
4. Create, update, or remove edges as needed.

**For cancellations specifically:**

- Edges to a cancelled task remain in place. Cancellation is transitive-aware.
- The question to answer is: **is there a replacement?**
  - **Yes** (a new task supersedes the cancelled one): rewire dependents to point at the replacement.
  - **No** (the scope is genuinely abandoned): dependents may need to be cancelled too, or re-scoped to no longer require the cancelled work.

Skipping propagation is how dependency graphs go stale. Stale graphs make Mymir useless.
