# Piyaz artifact contracts

The written shape of every long-form artifact: implementation plans, execution records, decision entries, notes, PR bodies, and the structured returns phase agents hand back. Sole home for these shapes.

What makes each artifact *good* (scope, criteria quality, tag and category choices) lives in [../artifacts.md](../artifacts.md). How the prose should sound lives in [../role.md](../role.md). This file is about form.

## The standard

Every Piyaz artifact has two readers: an engineer opening the task cold six weeks from now, and an agent about to act on it without asking a question. Both want the same thing, the technical state stated plainly. Write for that pair and you never have to choose between them.

The shape that serves both:

- **Headed sections in a fixed order**, so a reader scanning for one thing knows where it is and an agent can find it by heading. Each recipe below gives its order.
- **Short technical paragraphs**, two to four sentences per section, each carrying a fact rather than a transition.
- **File, symbol, endpoint, and command references as code spans:** `lib/auth/middleware.ts`, `Queue::front`, `POST /api/habits/:id/complete`, `bun run db:push`. PRs and issues as `#412` or the full URL. This is what lets a reader jump straight to the thing.
- **Bullet lists for three or more parallel items.** Two read better as a sentence.
- **Tables only for enumerable facts:** statuses, endpoints, a mapping. Anything with reasoning in it belongs in prose.
- **Headings (`##`, `###`) where the content warrants them:** `implementationPlan`, note bodies, PR bodies, and the record's optional Deliverables section call for them; shorter fields take structure only when it earns its place. A heading over one thin paragraph is scaffolding around nothing.

None of this licenses padding. A section with nothing to say gets left out, not filled.

## `implementationPlan`

The unabridged plan a coding agent executes without re-deriving your reasoning. Written at `draft → planned`, saved whole in one `set` op. Summarizing it defeats its purpose.

Sections, in order:

1. **Approach.** Two to four sentences: what you are building and the shape of the solution. Name the pattern being followed and the existing code it mirrors.
2. **Changes.** One bullet per file, as `path` plus what changes there. Include line numbers or symbol names where you have them.
3. **Edge cases.** The conditions the naive implementation gets wrong, each with the intended behavior.
4. **Verification.** The exact commands that prove it works, and what green looks like.
5. **Open questions**, only when some remain. Each with the option you would pick absent an answer.

Ground every claim: a file you have read, a doc you fetched, a command you ran. A plan citing a function that does not exist costs the implementer more than no plan.

## `executionRecord`

Carried by `in_review`, `done`, and `cancelled` tasks. It answers how the work was built, or why it was abandoned. The `description` says what was planned; the record says what happened. A `draft` task must not carry one, since the field implies the task shipped.

The core is plain prose, structured when the content warrants it, covering:

- What was built, by function name, file path, endpoint, and data format.
- The mechanism a reader would not guess from the description.
- What was verified and how.

Length follows content: leave out debugging stories, false starts, and filler, never the mechanism. For a `cancelled` task, the record carries the rationale for abandoning it, the approaches tried, and what was learned.

```
GOOD (web): "Added the completion endpoint at `POST /api/habits/:id/complete`
in `app/api/habits/[id]/complete/route.ts`. Inserts into `habit_logs` through
`withUserContext` and returns the recomputed streak. Idempotency comes from a
unique index on `(habit_id, log_date)`; a duplicate call returns the existing
row rather than erroring. Verified with `bun test tests/api/habit.test.ts`."

GOOD (cancelled): "Abandoned the custom LRU prompt cache. Benchmarked against
the provider's native caching in `scripts/bench-cache.ts` and measured no p99
improvement at our request shape. The provider cache already covers the prefix
reuse this task assumed was missing."
```

**Deliverables section (optional).** When the task ships non-code artifacts (a report, data file, rendered doc, dataset, benchmark result, dashboard), extend the record with a `## Deliverables` list: one bullet per artifact giving its path or URL and the exact regeneration command. Agent worktrees are ephemeral, so an uncommitted unlinked output is gone by review time. Commit repo-resident artifacts in the PR; link or record the rest here.

**Fix and rework rotations** are the one case where the author re-`set`s the field: fold the outcome into the final shipped state rather than appending per-rotation narrative. Otherwise the record accretes through `set` on the first write and `append` after. If you find yourself rewriting fields you did not author, stop.

## Decision entries

One line each, added with `add`, in the form **choice plus why**. The why is the constraint that made the choice, not a restatement of the choice.

```
GOOD: "Chose Redis for refresh tokens. Need fast revocation lookups."
GOOD: "Use `std::vector` for the Queue backing storage. Cheap front() lookup,
       fast tail insert; the spec is silent on container choice."
GOOD: "Use dbt incremental over full-refresh on `daily_active_users`. The source
       events table is 4B rows and full-refresh exceeds the 30-minute SLA."

BAD: "Used Drizzle"                      (no why)
BAD: "We picked Redis because it's good" (why carries no constraint)
BAD: "Decided to do it that way"         (no choice)
```

Decisions come from the conversation. When the user and an agent, or two agents, settle a choice, record it without being asked. If you are unsure whether a choice rises to decision level, ask briefly.

Two things do not belong here. Process metadata (a phase failed, a retry happened, a test flaked) belongs in the transcript or a run log. Anything not grounded in the conversation, the code, or a cited artifact stays out entirely.

Onboarding is the exception on sourcing: it recovers decisions made before Piyaz existed by reading manifests (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`), READMEs and design docs, and commit messages carrying words like *chose*, *switched*, *replaced*, *migrated*. A decision not grounded in one of those is omitted. A shorter list beats a fabricated one.

## Notes

A note is written for a teammate who was not here, so lead with the state and keep it skimmable.

- **`summary`**: one sentence, and often the only part another agent reads, since it rides every tree list, search hit, and feed pointer.
- **Body**: two to five short headed sections, or one compact list for a single idea. Name tasks by ref (`EVL-4`), never by UUID. State facts grounded in actual project state; a note that invents status is worse than no note.
- **Length** tracks type. `guidance` injects its full body into matching task bundles, so it stays a tight constraints block. `reference` is read by heading, so it can run long. `knowledge` entries stay short and dated.

A status note for someone joining next week is three sections: where the project stands, what is in flight and behind what, what to watch out for. Refs throughout, no generic advice. The reader sets the length: they will skim it in two minutes and click the refs for detail, so write what they need in order to act and stop there. Walking through every task restates the tracker; the note earns its place by saying what the tracker cannot, the synthesis and the watch-outs.

## PR bodies

Open a PR when `files` is non-empty and the work was a real code change.

**Detect a template** at `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE/<name>.md`, or `docs/pull_request_template.md`.

**If a template exists**, fill it, mapping task fields onto its sections only where they fit:

- Linked issue or task: the `taskRef` in brackets, `[LSQ-38]`. The bracket form triggers Piyaz PR-status tracking, so use it for the one primary task this PR builds and reference related tasks elsewhere as plain links. Add `Closes #N` on its own line when a GitHub issue is resolved.
- Summary: what shipped and why, condensed from the `executionRecord`.
- Test plan or verification: the acceptance criteria that are checked.
- Decisions or notes-for-reviewer, when present: the relevant `decisions` entries.

Leave a section blank rather than invent content for it. If the template asks a question you cannot answer, skip it.

**If no template exists**, use this default:

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

Open it with `gh pr create --title '<task title>' --body "$(cat <<'EOF' ... EOF)"`.

**Skip the PR** for research and investigation tasks, decision-only tasks, pure-Piyaz refinement with no repo changes, tasks the user said "no PR" on, and data or BA work without a code repo (a Looker dashboard tweak applied in the UI, a Tableau workbook published from Desktop, a metric definition signed off in a doc, an ad-hoc SQL analysis attached to a ticket, a BRD update in Confluence). For those, record the artifact link or path in `executionRecord` and `files` instead. When the data work does live in git (a dbt project, a SQL repo, a version-controlled notebook collection), open a PR under the standard rules. When in doubt, ask before opening.

## Phase-agent structured returns

Composer's per-task workflow dispatches each phase agent with an explicit return schema and captures a fixed set of fields. The phase contracts themselves live in the agent files; this is the shape of what crosses the boundary.

| Phase | Agent | Writes to Piyaz | Captured from the return |
|---|---|---|---|
| Research + plan (merged) | `piyaz:composer-researcher` under an orchestrator authority grant | refinement fields (`description`, `acceptanceCriteria`, `tags`, `category`, `priority`, `estimate`, `decisions`) plus `implementationPlan`; `status='planned'` on `draft → planned` only | brief, status, gatePhase, flags, confidence, refined estimate and work type, proposed rewrites, section and step counts, open questions |
| Implement | `piyaz:composer-implementer` | `status='in_progress'` (claim), `status='in_review'` with the Completion Protocol payload; fix mode rotates `in_review → in_progress → in_review` | status, PR URL, acceptance-criteria counts, concerns |
| CI gate | generic | nothing | `green` / `red` / `pending` / `none`, failing checks |
| Review | `piyaz:review` | nothing, read-only | verdict, blocking findings |

The workflow itself returns exactly one of three shapes. Branch on `result.status`, never on prose:

| `status` | Meaning | Also carries |
|---|---|---|
| `DONE` | the task ran to `in_review`, or to `planned` for a plannable-only pick | `outcome` (`in_review` / `planned`), `verdict`, `prUrl`, `ciState`, `acSatisfied` / `acTotal`, `rotations`, `escalated` (true when a `block` verdict or an exhausted fix budget left findings unaddressed), `blockingFindings`, `concerns` |
| `NEEDS_DECISION` | the merged research+plan phase gated | `result.gate` (the trigger) and `result.phase` (the raising half, `research` or `plan`) |
| `BLOCKED` | a phase could not complete | `result.phase` and `result.reason` |

A null return means the workflow died on a terminal error; treat it as `BLOCKED`.

The review verdict is one of `approve`, `request-changes`, or `block`, with file-cited reasoning across the security, performance, reliability, observability, and codebase-standards lenses, acceptance-criteria evaluation against the diff, plan-versus-diff drift, and downstream impact. It is advisory in every mode: HOTL owns the `in_review → done` transition.
