# Planner rules (composer Phase 2 extract)

Slim extract of the canonical mymir references for the composer planner.
Mirrors: `skills/mymir/references/conventions.md` §1,
`skills/mymir/references/artifacts.md` §1 (`description`,
`acceptanceCriteria`, `decisions`), §6, and
`skills/mymir/references/lifecycle.md` §1 (Summary, `draft`, `planned`),
§2.2 (Completion Protocol payload fields). Headings carry their canonical
file and section number so citations like `lifecycle §2.2` resolve
unambiguously. When editing a mirrored section, edit BOTH files.

---

## conventions §1 — The Iron Law of grounding

```
Never write what you cannot cite or do not know.
```

Applies wherever an agent generates `executionRecord`, `decisions`, `description`, or `files`.

- `executionRecord` claims must reference real code: file paths that exist, functions that are defined, endpoints that are routed, commits that are in the log. The onboarding agent verifies file existence with Bash before claiming.
- `description` must reflect actual scope. Do not stretch a one-line ask into an invented full feature.
- `files` must list paths the agent has either modified, observed, or has explicit confirmation exist.

When uncertain, write less. A short, true record is more valuable than a rich, fabricated one.

**Spec-review and open-questions tasks: cite the on-graph artifact.** When marking a spec-review, decision-only, or open-questions task `done`, every checked AC must cite an on-graph artifact: a sibling task's plan, a sibling's executionRecord, an edge note, or a decision recorded on a related task. Do not synthesize answers from training data. Reference the related task by ref (e.g. `MYMR-83`) inside the AC text or the executionRecord. This is what makes a spec-review completion honest instead of hallucinated.

`decisions` are different (see §1 of the artifact rules below). They come from the conversation, not from artifact-mining.

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

### `draft`

- **What it means.** Scope captured. The task is real but unbuilt.
- **Cannot:** be coded directly. Needs planning first.
- **Transitions to `planned`:** when an implementation plan is written and saved on the task. The plan must be unabridged. Do not save summaries.

### `planned`

- **What it means.** Implementation plan is written. All `depends_on` blockers are themselves `done`. Ready for someone to claim and code.
- **Transitions to `in_progress`:** when someone explicitly claims via `mymir_task action='update' status='in_progress'`. Claim BEFORE starting work; this prevents two agents from grabbing the same task.

---

## lifecycle §2.2 — Populate the required fields (Completion Protocol)

`executionRecord`, `decisions`, `files`, `acceptanceCriteria`, plus `prUrl` when a PR was opened (backend upserts a `task_links` row with `kind='pull_request'` so the review subagent and detail UI can resolve the PR). The MCP server returns `_hints` if any are missing. Re-call with the additions before continuing.

For pure spec-review / docs / decision-only / Mymir-only refinement tasks that touched no repo files, pass `files=[]` explicitly. Omitting the field leaves the prior value in place and the server's "missing files" hint will not clear. The empty array is the correct positive answer to "what changed in the repo?", not the absence of an answer.

(The planner pre-fills the plan's Completion Protocol template section against these field requirements; the implementer executes the full protocol from its own extract.)

---

## artifacts §1 — Task artifact quality

### `description`

The first thing a coding agent or engineer reads when picking up a task. It must be enough on its own to start the work. Concise and clear.

Cover, depending on task type:

- **Feature**: what the capability does, who it serves, where it lives in the architecture.
- **Bug**: what is broken, when it manifests, why it matters, and the suspected root cause if known.
- **Refactor / improvement**: what changes, what stays the same, why it is worth doing now.
- **Research / investigation**: what the question is, why it needs answering, what a good answer looks like.
- **Chore / setup / docs**: what needs doing and why now.

- **Solution sketch:** if you have one, include it. "Use Drizzle, mirror the patterns in `lib/data/task.ts`" is more useful than "Define the database tables".
- **No speculation:** do not pad with implementation guesses when the approach is uncertain. The implementation plan is for that.

Length: 2 to 4 sentences for most tasks. Up to 6 to 8 sentences for genuinely complex tasks. Single-sentence descriptions are rejected.

```
GOOD (feature, web SaaS):
"Build the habit completion endpoint at POST /api/habits/:id/complete. Inserts
into habit_logs with the user's timezone-adjusted date. Returns the updated
streak count. Idempotent on (habit_id, log_date): duplicate calls return the
existing log. Used by both the web dashboard and the iOS widget."

GOOD (bug, simulation engine):
"Fix Queue::front returning a copy instead of a reference. Spec §4.2.4.2
requires the head pointer to be modifiable in-place so Airport::moveToRunway
can swap it out without a re-insert. Currently caught by a unit test on
takeoff_flow. Likely a one-line change in include/Queue.h."

BAD: "Improve the database."
BAD: "Make auth better."
BAD: "Fix the bug in queue."
BAD: "Build the dashboard."
```

### `acceptanceCriteria`

2 to 4 items. Each criterion must be **binary**: a reviewer can answer YES or NO without ambiguity.

```
GOOD:
- "Running bun run db:push creates all tables without errors"
- "User table has id, email, name, passwordHash, createdAt columns"
- "FK from tasks.projectId to projects.id with ON DELETE CASCADE"
- "Seed script creates 3 test users and 2 projects with tasks"

GOOD (firmware):
- "spi_send returns within 50µs at 80MHz clock measured on logic analyzer"
- "DMA TX completion fires interrupt; no busy-loop in the driver"
- "spi_recv returns 0xFF when MISO is held high, verified on the bench"

BAD:
- "Database works"
- "All tables created"
- "Tests pass"
- "Performance is good"
```

Single-AC tasks are rejected. Tasks with vague ACs ("works correctly", "is complete", "performs well") are rejected.

### `decisions`

One-liner per decision. Format: **CHOICE + WHY**.

Where decisions come from:

- **Refinement, planning, or implementation conversation.** When the user and the agent (or two agents) settle on a choice, that's a decision. The agent should automatically record it without being asked. If the agent is uncertain whether a choice rises to "decision" level, ask the user briefly to confirm.
- **Onboarding (special case)**: the agent reads existing artifacts to recover decisions made before Mymir entered the picture. Sources: manifest files (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Package.swift`), README and design docs, commit messages with words like *chose*, *switched*, *replaced*, *migrated*. If a decision is not grounded in any of those, omit it. Better a shorter list than fabrication.

```
GOOD (web): "Chose Redis for refresh tokens. Need fast revocation lookups."
GOOD (sim): "Use std::vector for the Queue backing storage. Cheap front() lookup, fast tail insert; spec is silent on container choice."
GOOD (agentic): "Use a per-thread tool registry. Two concurrent agent loops were stepping on each other's MCP client state."

BAD: "Used Drizzle"
BAD: "We picked Redis because it's good"
BAD: "Decided to do it that way"
```

Never invent. If a decision is not grounded in conversation, code, or the artifacts above, leave it out.

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

### Em-dash replacements

```
BAD  (web):     "Custom auth — months of work — is off the table."
GOOD:           "Custom auth is off the table. Months of work, easy to leak data."

BAD  (sim):     "Rejected — see line 42 of the spec."
GOOD:           "Rejected. See line 42 of the spec."
```

### Length

Concision over padding. No filler, no AI throat-clearing, no repetition. But do not sacrifice clarity for brevity. If a task genuinely needs 6 to 8 sentences in its description because the architecture has multiple components, the bug has a complex cause, or the research question is multi-part, write them. The rule is "no fluff", not "no length". A 6-sentence description that helps a reader is better than a 2-sentence one that loses them.
