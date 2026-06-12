# Reviewer rules (composer Phase 4 extract)

Slim extract of the canonical mymir references for the review agent.
Mirrors: `skills/mymir/references/conventions.md` §1,
`skills/mymir/references/lifecycle.md` §2.2, §2.3, §2.4, §3, and
`skills/mymir/references/artifacts.md` §1 (`executionRecord`,
`decisions`), §6. Headings carry their canonical file and section number
so citations like `lifecycle §2.2` resolve unambiguously. When editing a
mirrored section, edit BOTH files.

The reviewer verifies the Completion Protocol was honored; it does not
execute it. §2.2 and §2.3 below are what the implementer was required to
do; §3 is what the orchestrator runs after your verdict, fed by your
downstream-impact list.

---

## conventions §1 — The Iron Law of grounding

```
Never write what you cannot cite or do not know.
```

Applies wherever an agent generates `executionRecord`, `decisions`, `description`, or `files`. For the reviewer it applies to the verdict: every finding cites a real file path and line, every AC evaluation cites the diff or the executionRecord. When uncertain, write less. A short, true verdict is more valuable than a rich, fabricated one.

---

## lifecycle §2.2 — Populate the required fields

`executionRecord`, `decisions`, `files`, `acceptanceCriteria`, plus `prUrl` when a PR was opened (backend upserts a `task_links` row with `kind='pull_request'` so the review subagent and detail UI can resolve the PR). The MCP server returns `_hints` if any are missing.

For pure spec-review / docs / decision-only / Mymir-only refinement tasks that touched no repo files, `files=[]` is the correct positive answer to "what changed in the repo?", not the absence of an answer.

## lifecycle §2.3 — Open a PR if the work changed code (what the implementer owed)

If `files` is non-empty AND the work was a real code change (not research, not decision-only, not Mymir-only refinement), the implementer must have opened a PR:

- PR body follows the repo's PR template when one exists (`.github/PULL_REQUEST_TEMPLATE.md` and variants), the canonical concise default otherwise.
- The `taskRef` appears in `[BRACKETS]` (e.g. `[MYMR-83]`) exactly once, for the ONE primary task the PR builds. Bracket form triggers Mymir PR-status tracking. Related tasks are referenced as plain links, no brackets.
- Summary maps from `executionRecord` (2 to 3 sentences); test plan maps from checked `acceptanceCriteria`; notes-for-reviewer maps from `decisions`.
- Sections are concise; empty optional sections beat fabricated content.

A missing PR on a code-changing task, a missing bracket ref, or a fabricated template section is a finding.

## lifecycle §2.4 — Skip the PR for these task types

A missing PR is legitimate (not a finding) for:

- Research / investigation tasks (no code change).
- Decision-only tasks.
- Pure-Mymir refinement tasks (no repo changes).
- Tasks the user explicitly said "no PR" on.
- Data and BA work without a code repo (dashboard tweaks, workbooks, metric sign-offs, ad-hoc SQL attached to a ticket). The deliverable lives outside git; the artifact link or path belongs in `executionRecord` and `files`. When the data work IS in a git repo (a dbt project, a versioned SQL or notebook repo), the standard PR rules apply.

---

## lifecycle §3 — Propagate after every change (Iron Law)

```
A change that does not propagate did not happen.
```

The graph is Mymir's value. Skip once and it lies: ready tasks that aren't ready, blockers pointing at shipped work, every future session picking the wrong next step.

After any status change or significant refinement:

1. `mymir_query type='edges'` on the changed task. Current relationships.
2. `mymir_analyze type='downstream'`. Who depends on this task.
3. For each downstream task, evaluate:
   - Do edge notes need updating to reflect new decisions?
   - Are there NEW relationships revealed by this change?
   - Are there STALE relationships that no longer hold?
   - Do downstream descriptions need updating based on the decisions made?
4. Create, update, or remove edges as needed.

The reviewer does not execute propagation. Your downstream-impact list names the edges that will need attention; the orchestrator (or the human) executes the rewires.

---

## artifacts §1 — Task artifact quality

### `executionRecord` (only on `in_review`, `done`, and `cancelled`)

The implementer writes this field at the `in_review` transition; you verify it against the diff.

- **Length:** 3 to 5 sentences.
- **Distinct from `description`:** description = scope + role; executionRecord = HOW it was built (or WHY it was abandoned).
- **Include:** function names, file paths, endpoints, data formats.
- **Exclude:** debugging stories, false starts, filler.
- **For `cancelled`:** rationale (why abandoned), approaches tried, decisions learned. Same shape as a done record, just for non-shipping outcomes.
- **Draft tasks must NOT carry an `executionRecord`.** That field implies the task shipped.

### `decisions`

One-liner per decision. Format: **CHOICE + WHY**.

```
GOOD (web): "Chose Redis for refresh tokens. Need fast revocation lookups."
GOOD (sim): "Use std::vector for the Queue backing storage. Cheap front() lookup, fast tail insert; spec is silent on container choice."

BAD: "Used Drizzle"
BAD: "We picked Redis because it's good"
BAD: "Decided to do it that way"
```

Never invent. An implementer `decisions` entry that is not grounded in the diff, the plan, or the conversation is a finding.

---

## artifacts §6 — Markdown formatting and tone

Applies to everything you write into the verdict.

### Structure

- Bullet lists (`-`) for 3 or more items. Never run-on prose.
- Backticks for code references: file paths, function names, endpoints, variables, package names.
- Paragraph breaks between distinct topics.

### Tone: never sound like AI

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

Concision over padding. No filler, no repetition. The rule is "no fluff", not "no length".
