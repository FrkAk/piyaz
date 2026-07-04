# Researcher rules (composer Phase 1 extract)

Slim extract of the canonical piyaz references for the composer researcher.
Mirrors: `skills/piyaz/references/conventions.md` §1, §4 and
`skills/piyaz/references/artifacts.md` §1 (`description`,
`acceptanceCriteria`, `decisions`), §2, §5, §6. Headings carry their
canonical file and section number so citations like `conventions §1`
resolve unambiguously. When editing a mirrored section, edit BOTH files.

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

`decisions` are different (see §1 of the artifact rules below). They come from the conversation, not from artifact-mining.

---

## conventions §4 — taskRef format

Tool responses include a `taskRef` like `WHL-214`: uppercase project prefix, dash, integer. **Refs are first-class everywhere: use them in user-facing output AND in tool calls** (`task='WHL-214'`, `project='WHL'`). UUIDs also work and are the fallback when a ref is ambiguous across teams (the error lists the candidates with their UUIDs). Chain the refs that responses emit; never invent one — a miss returns the highest existing ref for the prefix.

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

Length: 2 to 4 sentences for most tasks. Up to 6 to 8 sentences for genuinely complex tasks. Single-sentence descriptions are never acceptable: the server flags them in `_hints`; rewrite before moving on.

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

GOOD (research, ML platform):
"Investigate whether torch.compile improves training throughput on the
ResNet-50 baseline. Question: does compile-time speedup outweigh JIT overhead
on our 8-GPU pod? A good answer is a benchmark script plus a one-paragraph
recommendation comparing wall-clock per epoch and peak memory."

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

Single-AC tasks are flagged by the server in `_hints`; rewrite them. Tasks with vague ACs ("works correctly", "is complete", "performs well") must be rewritten before planning.

### `decisions`

One-liner per decision. Format: **CHOICE + WHY**.

Decisions come from the refinement, planning, or implementation conversation. When the user and the agent (or two agents) settle on a choice, that's a decision. The agent should automatically record it without being asked. If the agent is uncertain whether a choice rises to "decision" level, ask the user briefly to confirm.

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

## artifacts §2 — Tag dimensions and first-class fields

Every task, in every status, must carry tags across the three tag dimensions below. Reuse existing tags from `piyaz_get view='meta'` before coining new ones.

| Dimension | Count | Vocabulary |
|---|---|---|
| **Work type** | exactly 1 | `bug`, `feature`, `refactor`, `docs`, `test`, `chore`, `perf` |
| **Cross-cutting concern** | ≥1 | quality attribute (`security`, `a11y`, `dx`, `perf`, `reliability`, `observability`, `i18n`, `compliance`, `safety`) or feature cluster spanning multiple categories (web: `onboarding-flow`, `live-replay`; aerospace: `flight-control`, `mission-planning`; agentic: `agent-loop`, `eval-harness`; ML: `inference-pipeline`, `data-drift`; financial: `risk-engine`, `pricing-model`) |
| **Tech** | at most 2 | most important stack pieces the task touches; pull from manifest deps |

### First-class fields (priority, estimate, assignees)

These are top-level columns on every task, set at creation (`piyaz_create` item fields) or via `piyaz_edit` (`set field='priority'` etc.). They are NOT tags.

- **`priority`** (one of `urgent`, `core`, `normal`, `backlog`). Required-on-create-by-convention: pick deliberately. Defaults: onboarding (shipped features) lands at `core`; decompose picks per task and avoids `core` everywhere or `urgent` everywhere (the dimension carries no signal then). A 30-task project usually has 3 to 6 `urgent` tasks and the rest split between `core`, `normal`, and `backlog`.
- **`estimate`** (Fibonacci story points: `1`, `2`, `3`, `5`, `8`, `13`). Optional. `1` is trivial, `2` and `3` are routine, `5` is nontrivial, `8` and `13` are risky or multi-day. If a task feels larger than `13`, split it (§5).
- **`assigneeIds`** (array of team-member user UUIDs). Optional. Declares ownership / intent, not concurrent execution; the single-worker `in_progress` invariant still holds. Each id must be a member of the project's owning team (the server rejects non-members at write time).

**Do NOT tag:**

- Priority: that is the `priority` field's job. Setting `urgent`, `core`, `normal`, or `backlog` as tags duplicates the field and adds no signal.
- Codebase area: that's `category`'s job. **Test: would this name plausibly be a category in some other project shape?** `render-loop`, `effect-system`, `auth`, `payments`, `inference`, `marts`, `flight-control`, `hal-drivers` all answer YES. They're subsystems / product areas, even if your project's category list happens to omit them. Tags are axes the project does not shape itself around: quality attributes (`security`, `a11y`, `perf`, `reliability`, `observability`, `dx`, `compliance`, `safety`, `i18n`) and multi-category feature clusters (`onboarding-flow`, `agent-loop`, `mission-planning`, `live-replay`). If a candidate tag names a subsystem, surface it as a category proposal at the gate or use the existing category. Coining an area-shaped tag because the categories lack a good slot is a category-list bug, not a tag.
- Task status: that is `status`'s job.
- Generic adjectives like "important", "main", "primary".

**Honoring user-specified tags:** if the user explicitly tagged something, preserve their tags. Add the missing dimensions if any of the three are absent.

**Tech tag examples by domain:**

- Web: `react`, `next`, `drizzle`, `postgres`, `tailwind`
- Embedded: `c`, `rust`, `freertos`, `stm32-hal`, `zephyr`
- Data / ML: `sql`, `dbt`, `pytorch`, `clickhouse`, `airflow`

Pull tech tags from the project's actual stack. Do not invent.

---

## artifacts §5 — Granularity

**1 to 4 hours per task.** A coding agent should complete one in a single session.

Too small (under 30 minutes): overhead exceeds work.
Too large (over 1 day): hidden subtasks, unclear scope, hard to track.

When in doubt, split. Tasks become more useful, and more parallelizable, as they shrink toward the 1-hour mark. Splitting is the decompose agent's job; the researcher's part is raising `oversize-task` when the true scope exceeds what `13` represents.

---

## artifacts §6 — Markdown formatting and tone

Applies to `description`, `acceptanceCriteria`, `executionRecord`, `implementationPlan`, `decisions`, and edge `note`. Not to `files` (plain paths) or `tags` (kebab-case).

### Structure

- Bullet lists (`-`) for 3 or more items. Never run-on prose.
- Backticks for code references: file paths, function names, endpoints, variables, package names.
- Paragraph breaks between distinct topics.
- Headings (`##`, `###`) only in long fields like `implementationPlan`.

### Tone: never sound like AI

The text you write into Piyaz is read by other engineers. It must read like an engineer wrote it, not a chatbot.

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

Concision over padding. No filler, no AI throat-clearing, no repetition. But do not sacrifice clarity for brevity. If a task genuinely needs 6 to 8 sentences in its description because the architecture has multiple components, the bug has a complex cause, or the research question is multi-part, write them. The rule is "no fluff", not "no length". A 6-sentence description that helps a reader is better than a 2-sentence one that loses them.
