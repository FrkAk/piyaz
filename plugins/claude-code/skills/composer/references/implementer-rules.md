# Implementer rules (composer Phase 3 extract)

Slim extract of the canonical mymir references for the composer
implementer. Mirrors: `skills/mymir/references/conventions.md` §1, §2,
`skills/mymir/references/lifecycle.md` §1 (Summary, `in_progress`,
`in_review`), §2 (entire Completion Protocol, 2.1–2.4), and
`skills/mymir/references/artifacts.md` §1 (`executionRecord`,
`decisions`, `files`), §6. Headings carry their canonical file and
section number so citations like `lifecycle §2` resolve unambiguously.
When editing a mirrored section, edit BOTH files.

---

## conventions §1 — The Iron Law of grounding

```
Never write what you cannot cite or do not know.
```

Applies wherever an agent generates `executionRecord`, `decisions`, `description`, or `files`.

- `executionRecord` claims must reference real code: file paths that exist, functions that are defined, endpoints that are routed, commits that are in the log.
- `description` must reflect actual scope. Do not stretch a one-line ask into an invented full feature.
- `files` must list paths the agent has either modified, observed, or has explicit confirmation exist.

When uncertain, write less. A short, true record is more valuable than a rich, fabricated one.

`decisions` come from the conversation and the work, not from artifact-mining. Never invent them.

---

## conventions §2 — Tool descriptions and `_hints` are runtime instructions

Every Mymir tool injects two things into your context at use time:

1. The tool's description and parameter schema, visible before the call.
2. A `_hints` array in the response, visible after the call.

These are not optional commentary. They are server-side rules and state you cannot see otherwise. They override any prior plan you had.

**Read on every tool call. Act before continuing.**

Examples of hints you must obey:

- Missing required fields on `done`: hint says `executionRecord is required`. Re-call with the field.
- Tool description says "REQUIRED in multi-team accounts". The server rejects ambiguous calls.
- Hint says "no ready tasks; try `mymir_analyze type='plannable'`". Switch to plannable. Do not invent ready work.
- Hint says "edges to cancelled task remain in place". Respect transitive blocking when reasoning about downstream readiness.

**Order rule when multiple hints fire.** When two or more `_hints` come back in the same response (e.g. "missing files" plus "run propagation"), service them in order: required-field hints first (the task is not in its final state until they clear), then informational follow-ups (propagation, suggested next call). The propagation hint is informational and can be deferred a turn; a missing-required-field hint must be cleared before the task is considered fully transitioned.

Skipping a hint is operating on stale information. A session that ignores hints generates output the server already knows is wrong.

---

## lifecycle §1 — Status lifecycle

```
draft → planned → in_progress → in_review → done
                                            cancelled (terminal, reachable from any non-terminal)
```

### Summary

| Status | Required fields | Forbidden fields | Trigger to leave |
|---|---|---|---|
| `draft` | `description`, `acceptanceCriteria` | `executionRecord`, `implementationPlan` | implementation plan saved → `planned` |
| `planned` | + `implementationPlan` (unabridged); all `depends_on` blockers `done` | `executionRecord` | someone claims via `action='update' status='in_progress'` → `in_progress` |
| `in_progress` | + active worker (one only) | — | work complete + record + ACs + Completion Protocol §2 run → `in_review` |
| `in_review` | + `executionRecord`, `decisions`, `files`, every AC evaluated, `prUrl` (optional sugar — when a PR was opened; backend upserts a `task_links` row with `kind='pull_request'`) | — | HOTL operator inspects PR and flips → `done` (or back to `in_progress` for rework) |
| `done` | (inherited from `in_review`) | — | terminal |
| `cancelled` | + `executionRecord` (rationale + what was tried), `decisions` | — | terminal |

### `in_progress`

- **What it means.** Active implementation. Exactly one engineer or agent is working on it.
- **Constraint:** should not span sessions. If work pauses, leave a note in the task or move it back to `planned`.
- **Transitions to `in_review`:** when implementation is complete, `executionRecord` / `decisions` / `files` are populated, acceptance criteria are evaluated, and the Completion Protocol (§2) has run.

### `in_review`

- **What it means.** Implementer subagent has finished the work, opened a PR, and populated the full Completion Protocol payload (`executionRecord`, `decisions`, `files`, evaluated `acceptanceCriteria`). Tests, lint, and typecheck are green. Awaiting human review on the PR.
- **Cannot:** be self-promoted to `done` by any agent. The HOTL operator owns the `in_review → done` transition.
- **Transitions to `done`:** when the PR is approved/merged and the operator updates status. No additional payload is required; the implementer already populated everything.
- **Transitions back to `in_progress`:** when the reviewer requests rework. The implementer or a follow-up worker picks the task up again from `in_progress`.

---

## lifecycle §2 — Completion Protocol

Before transitioning a task to `in_review`, `done`, or `cancelled`:

### 2.1. Detect mode by transcript

- **Dispatched mode**: your context shows you were invoked via the Task tool by a parent agent. Mark `in_review` directly with the full payload (the implementer's terminal write); the HOTL operator finalizes to `done`. Return to the parent with the task ref and a one-sentence summary. Do not ask.
- **Direct mode**: invoked by the user in a normal session. Ask "Ready to mark this `in_review`?" with a one-sentence executionRecord preview. Wait for explicit confirmation; the HOTL operator finalizes to `done` after PR approval.
- **Uncertain**: default to asking. A spurious confirmation prompt is cheap; an unauthorized status change is expensive.

### 2.2. Populate the required fields

`executionRecord`, `decisions`, `files`, `acceptanceCriteria`, plus `prUrl` when a PR was opened (backend upserts a `task_links` row with `kind='pull_request'` so the review subagent and detail UI can resolve the PR). The MCP server returns `_hints` if any are missing. Re-call with the additions before continuing.

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

## artifacts §1 — Task artifact quality

### `executionRecord` (only on `in_review`, `done`, and `cancelled`)

You write this field at the `in_review` transition; it is the core of your Completion Protocol payload.

- **Length:** 3 to 5 sentences.
- **Distinct from `description`:** description = scope + role; executionRecord = HOW it was built (or WHY it was abandoned).
- **Include:** function names, file paths, endpoints, data formats.
- **Exclude:** debugging stories, false starts, filler.
- **For `cancelled`:** rationale (why abandoned), approaches tried, decisions learned. Same shape as a done record, just for non-shipping outcomes.
- **Draft tasks must NOT carry an `executionRecord`.** That field implies the task shipped.

### `decisions`

One-liner per decision. Format: **CHOICE + WHY**.

Decisions come from the refinement, planning, or implementation conversation. When a choice is settled (by you against the codebase, or with the user), record it without being asked.

```
GOOD (web): "Chose Redis for refresh tokens. Need fast revocation lookups."
GOOD (sim): "Use std::vector for the Queue backing storage. Cheap front() lookup, fast tail insert; spec is silent on container choice."
GOOD (agentic): "Use a per-thread tool registry. Two concurrent agent loops were stepping on each other's MCP client state."

BAD: "Used Drizzle"
BAD: "We picked Redis because it's good"
BAD: "Decided to do it that way"
```

Never invent. If a decision is not grounded in conversation, code, or the artifacts above, leave it out.

### `files`

- **Format:** plain repo-relative path strings. No backticks, no quoting.
- **Coverage:** every file created or modified for `done` tasks.
- **Empty `files=[]` is the correct value whenever paths cannot be cited:** pre-implementation tasks (`draft`, `planned`) where the code does not exist yet, research or decision-only tasks, Mymir-only refinements. **Leave empty rather than speculate.**

---

## artifacts §6 — Markdown formatting and tone

Applies to `description`, `acceptanceCriteria`, `executionRecord`, `implementationPlan`, `decisions`, and edge `note`. Not to `files` (plain paths) or `tags` (kebab-case).

### Structure

- Bullet lists (`-`) for 3 or more items. Never run-on prose.
- Backticks for code references: file paths, function names, endpoints, variables, package names.
- Paragraph breaks between distinct topics.
- Headings (`##`, `###`) only in long fields like `implementationPlan`.

### Tone: never sound like AI

The text you write into Mymir is read by other engineers. It must read like an engineer wrote it, not a chatbot.

**Do not use:**

- Em dashes (the `—` character). Use periods, commas, parentheses, or colons.
- Hedging openers: "I think", "perhaps", "seems to", "might be", "arguably".
- Enthusiasm: "Great question", "Awesome", "Exciting", "Love this".
- Throat-clearing: "Let me dive into", "I hope this helps", "Here's the thing", "To be honest".
- Marketing words: "comprehensive", "robust", "powerful", "leverage", "utilize", "ensure", "facilitate", "seamless", "game-changer", "best-in-class".
- Adverb-heavy openers: "Importantly", "Crucially", "Notably", "Essentially", "Basically".
- Empty filler: "It's worth noting that", "It should be mentioned", "As a matter of fact".
- Performative summaries at the end: "I hope this helps!", "Let me know if you need anything else!"

**Do:**

- Subject, verb, object.
- Active voice.
- Concrete over abstract. "Adds 50ms p99" beats "improves performance".
- Specific over vague. "Stripe webhook handler" beats "payment integration".
- Cut adverbs.
- One idea per sentence.

### Length

Concision over padding. No filler, no AI throat-clearing, no repetition. But do not sacrifice clarity for brevity. The rule is "no fluff", not "no length".
