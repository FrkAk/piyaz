# Piyaz artifact rules

Quality bar for everything an agent writes into Piyaz: titles, descriptions, acceptance criteria, executionRecords, decisions, files, tags, edges, categories, and the markdown tone of all of it.

Agents read this file when about to create, refine, or audit an artifact. The Iron Law of grounding (`conventions.md` §1) applies at every step.

> Sections of this file are mirrored by the composer phase extracts in the claude-code plugin (`plugins/claude-code/skills/composer/references/`); when you edit a mirrored section, update those extracts and bump the pin in their `sources.json`.

## Contents

- §1 Task artifact quality: title, description, acceptanceCriteria, executionRecord, decisions, files
- §2 Tag dimensions and first-class fields (priority, estimate, assignees)
- §3 Edge types and decision criteria
- §4 Categories: selection walkthrough, hard rules, forbidden list, project-type guidance
- §5 Granularity: task sizing and starting counts
- §6 Markdown formatting and tone

---

## 1. Task artifact quality

### Title

Verb plus noun, imperative.

```
GOOD: "Implement JWT auth"
GOOD: "Fix Queue::front returning a copy"
GOOD: "Profile renderer hot path"
GOOD: "Train baseline ResNet on internal dataset"

BAD: "Auth"
BAD: "Queue stuff"
BAD: "Performance"
```

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

**For onboarding** (writing descriptions for tasks that already shipped): write the description as if the task were being created BEFORE the work, knowing what you now know about the codebase. The reader must be able to re-derive the work from the description. Do not write "added the auth middleware". Write "Build the JWT auth middleware in `lib/auth/middleware.ts`. Validate Bearer tokens against the user table, set `req.user`, reject on expiry. Required by every protected route."

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

GOOD (refactor, embedded firmware):
"Move the SPI driver from polling to DMA. Same public surface (spi_send,
spi_recv), same wire protocol. Internally use STM32 HAL DMA1 channel 3 for
TX. Reduces CPU usage during sensor reads from ~15% to <1% per existing
profile traces."

GOOD (feature, game engine):
"Add deterministic frame stepping to the simulation tick. New API
Engine::stepFrame(uint32_t seed) so replay tooling and netcode tests can
re-run identical state from a recorded seed. Affects PhysicsWorld, Scheduler,
and the InputBuffer drain order."

GOOD (data / dbt model build):
"Build the daily_active_users dbt model in models/marts/engagement/. Reads
from stg_events.session_started, deduplicates on (user_id, date_trunc('day',
event_ts)), excludes internal traffic via is_internal flag from dim_users.
Materializes incremental on event_date with a 7-day lookback window. Used by
the Looker `Engagement Overview` dashboard and the weekly stakeholder report."

GOOD (BA / metric definition):
"Define the gross_margin metric in the dbt metrics layer. Formula: (revenue
- cogs) / revenue, dimensioned by product_line, channel, and order_month.
Source: fct_orders joined to dim_products. Replaces the four near-duplicate
SQL versions currently maintained by Sales Ops, Finance, and Marketing.
Stakeholders: CFO weekly review, RevOps dashboard."

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

GOOD (data / dbt):
- "dbt run --select daily_active_users completes in under 90s on prod warehouse"
- "Row count of daily_active_users on 2026-05-01 matches stg_events session count to within 0.1%"
- "dbt test passes: not_null on user_id and event_date, unique on (user_id, event_date)"
- "Looker `Engagement Overview` dashboard refreshes against the new model with no broken tiles"

GOOD (BA / analysis deliverable):
- "Churn analysis SQL in analyses/2026q2_churn.sql returns the 14 churned cohorts with ARR per cohort"
- "Numbers reconcile with finance_actuals.gross_revenue to within $500 for every month in scope"
- "Stakeholder review notes from the 2026-05-08 RevOps sync are attached to the task"

BAD:
- "Database works"
- "All tables created"
- "Tests pass"
- "Performance is good"
- "Dashboard looks right"
- "Numbers match"
```

Single-AC tasks are flagged by the server in `_hints`; rewrite them. Tasks with vague ACs ("works correctly", "is complete", "performs well") must be rewritten before planning.

### `executionRecord` (only on `in_review`, `done`, and `cancelled`)

- **Length:** 3 to 5 sentences.
- **Distinct from `description`:** description = scope + role; executionRecord = HOW it was built (or WHY it was abandoned).
- **Include:** function names, file paths, endpoints, data formats.
- **Exclude:** debugging stories, false starts, filler.
- **For `cancelled`:** rationale (why abandoned), approaches tried, decisions learned. Same shape as a done record, just for non-shipping outcomes.
- **Deliverables section (optional):** when the task ships non-code artifacts, a `## Deliverables` list (path or URL plus the exact regeneration command per artifact) extends the record beyond the sentence core.
- **Draft tasks must NOT carry an `executionRecord`.** That field implies the task shipped.

### `decisions`

One-liner per decision. Format: **CHOICE + WHY**.

Where decisions come from:

- **Refinement, planning, or implementation conversation.** When the user and the agent (or two agents) settle on a choice, that's a decision. The agent should automatically record it without being asked. If the agent is uncertain whether a choice rises to "decision" level, ask the user briefly to confirm.
- **Onboarding (special case)**: the agent reads existing artifacts to recover decisions made before Piyaz entered the picture. Sources: manifest files (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Package.swift`), README and design docs, commit messages with words like *chose*, *switched*, *replaced*, *migrated*. If a decision is not grounded in any of those, omit it. Better a shorter list than fabrication.

```
GOOD (web): "Chose Redis for refresh tokens. Need fast revocation lookups."
GOOD (web): "Switched from Prisma to Drizzle. See package.json migration commit."
GOOD (sim): "Use std::vector for the Queue backing storage. Cheap front() lookup, fast tail insert; spec is silent on container choice."
GOOD (ML):  "Chose ONNX runtime over PyTorch for inference. 30% lower p99 on the target Jetson Orin."
GOOD (embedded): "Pick Zephyr over FreeRTOS for the new flight controller. Built-in CAN driver, Apache-2.0 license."
GOOD (agentic): "Use a per-thread tool registry. Two concurrent agent loops were stepping on each other's MCP client state."
GOOD (data): "Use dbt incremental over full-refresh on daily_active_users. Source events table is 4B rows; full-refresh exceeds the 30-minute warehouse SLA."
GOOD (BA): "Adopt dbt metrics layer over per-dashboard SQL. Four duplicates of gross_margin already exist across Looker, Tableau, and the weekly deck; one definition replaces them all."

BAD: "Used Drizzle"
BAD: "We picked Redis because it's good"
BAD: "Decided to do it that way"
BAD: "dbt is better"
```

Never invent. If a decision is not grounded in conversation, code, or the artifacts above, leave it out.

### `files`

- **Format:** plain repo-relative path strings. No backticks, no quoting.
- **Coverage:** every file created or modified for `done` tasks.
- **Empty `files=[]` is the correct value whenever paths cannot be cited:** pre-implementation tasks (`draft`, `planned`) where the code does not exist yet, research or decision-only tasks, Piyaz-only refinements. **Leave empty rather than speculate.**

---

## 2. Tag dimensions and first-class fields

Every task, in every status, must carry tags across the three tag dimensions below. Reuse existing tags from `piyaz_get project='<identifier>' view='meta'` before coining new ones.

| Dimension | Count | Vocabulary |
|---|---|---|
| **Work type** | exactly 1 | `bug`, `feature`, `refactor`, `docs`, `test`, `chore`, `perf` |
| **Cross-cutting concern** | ≥1 | quality attribute (`security`, `a11y`, `dx`, `perf`, `reliability`, `observability`, `i18n`, `compliance`, `safety`) or feature cluster spanning multiple categories (web: `onboarding-flow`, `live-replay`; aerospace: `flight-control`, `mission-planning`; agentic: `agent-loop`, `eval-harness`; ML: `inference-pipeline`, `data-drift`; financial: `risk-engine`, `pricing-model`) |
| **Tech** | at most 2 | most important stack pieces the task touches; pull from manifest deps |

### First-class fields (priority, estimate, assignees)

These are top-level columns on every task, set at creation (`piyaz_create` item fields) or via `piyaz_edit` (`set field='priority'` etc.). They are NOT tags.

- **`priority`** (one of `urgent`, `core`, `normal`, `backlog`). Required-on-create-by-convention: pick deliberately. Defaults: onboarding (shipped features) lands at `core`; decompose picks per task and avoids `core` everywhere or `urgent` everywhere (the dimension carries no signal then). A 30-task project usually has 3 to 6 `urgent` tasks and the rest split between `core`, `normal`, and `backlog`.
- **`estimate`** (Fibonacci story points: `1`, `2`, `3`, `5`, `8`, `13`). Optional. `1` is trivial, `2` and `3` are routine, `5` is nontrivial, `8` and `13` are risky or multi-day. If a task feels larger than `13`, split it (§5).
- **`assigneeIds`** (array of team-member user UUIDs). Optional. Declares ownership / intent, not concurrent execution; the single-worker `in_progress` invariant still holds. Each id must be a member of the project's owning team (the server rejects non-members at write time). Discover teammate UUIDs via `piyaz_workspace action='members'`.

**Do NOT tag:**

- Priority: that is the `priority` field's job. Setting `urgent`, `core`, `normal`, or `backlog` as tags duplicates the field and adds no signal.
- Codebase area: that's `category`'s job. **Test: would this name plausibly be a category in some other project shape?** `render-loop`, `effect-system`, `auth`, `payments`, `inference`, `marts`, `flight-control`, `hal-drivers` all answer YES. They're subsystems / product areas, even if your project's category list happens to omit them. Tags are axes the project does not shape itself around: quality attributes (`security`, `a11y`, `perf`, `reliability`, `observability`, `dx`, `compliance`, `safety`, `i18n`) and multi-category feature clusters (`onboarding-flow`, `agent-loop`, `mission-planning`, `live-replay`). If a candidate tag names a subsystem, surface it as a category proposal at the gate or use the existing category. Coining an area-shaped tag because the categories lack a good slot is a category-list bug, not a tag.
- Task status: that is `status`'s job.
- Generic adjectives like "important", "main", "primary".

**Honoring user-specified tags:** if the user explicitly tagged something, preserve their tags. Add the missing dimensions if any of the three are absent.

**Tech tag examples by domain:**

- Web: `react`, `next`, `drizzle`, `postgres`, `tailwind`
- Mobile: `swift`, `swiftui`, `kotlin`, `coreml`, `room`
- Game: `unity`, `unreal`, `cpp`, `glsl`, `wgsl`
- Simulation: `cpp`, `fortran`, `mpi`, `cuda`
- Embedded: `c`, `rust`, `freertos`, `stm32-hal`, `zephyr`
- ML: `pytorch`, `jax`, `triton`, `clickhouse`, `dvc`
- Financial: `python`, `quantlib`, `numpy`, `arrow`
- Data / analytics / BA: `sql`, `dbt`, `bigquery`, `snowflake`, `postgres`, `looker`, `tableau`, `metabase`, `powerbi`, `airflow`, `dagster`

Pull tech tags from the project's actual stack. Do not invent.

---

## 3. Edge types and decision criteria

Two types: `depends_on` (source needs target done first) and `relates_to` (informational link).

**Use `depends_on` when** the source task **cannot start or complete** without the target's output:

- Source needs code, APIs, or schema produced by the target.
- Source needs decisions or configuration defined in the target.

**Use `relates_to` when** tasks share context but **neither blocks the other**:

- They touch the same area of code but can be built independently.
- One task's decisions are useful context for the other, but not required.

**The litmus test:** if removing the target task makes the source impossible, it's `depends_on`. If it just makes it harder or less informed, it's `relates_to`.

**Edge notes propagate to coding agent context.** Empty notes ("needed", "depends") are forbidden. Write them as a brief to a developer about to start the source task: what specifically does this task get from the target?

```
GOOD (web): "User API endpoints need the JWT middleware and token
validation helpers built in the auth task. See lib/auth/middleware.ts."

GOOD (sim): "Crash flow runs each tick at the head of landingQueue.
Needs TimeController's per-tick hook structure built in NVK-18."

GOOD (agentic): "Tool registration depends on the agent loop's MCP client
init. Tools added after init are missed by in-flight agents."

GOOD (embedded): "BMP280 sustained-read fix depends on the i2c
clock-stretch patch in firmware-22. Without it the sensor returns 0xFF."

GOOD (ML): "Inference server depends on the model export task producing
ONNX with opset 18. Older opsets miss the GroupNorm op."

GOOD (data): "Looker `Engagement Overview` dashboard depends on the
daily_active_users dbt model. Tile queries select from the marts schema
and break if the model is renamed or its grain changes."

GOOD (BA): "The Q2 churn analysis depends on the gross_margin metric
definition in the dbt metrics layer. Without it, the cohort ARR column
defaults to the legacy SQL formula and reconciles 0.6% off finance_actuals."

BAD: "needs auth"
BAD: "depends on this"
BAD: "related"
```

---

## 4. Categories

Categories drive drawer grouping in the UI. Every task gets exactly one. They are set in exactly four moments:

1. When the project is created (the user names them, or you propose them at the gate).
2. During decompose, as part of the Phase 1 plan presented to the user before any write.
3. During onboarding, as part of the proposal presented at the Phase 3 gate.
4. When the user explicitly asks to add or remove one.

Do not silently coin a new category mid-decompose, mid-onboarding, or while creating an ad-hoc task. The category list is part of a project's scaffolding; sprawl here pollutes every overview view forever.

### How to determine categories for a project

You are choosing the architectural layers / product areas / subsystems of a single project. Walk through:

1. **What does the project do at a high level?** Web app, mobile app, game, simulation, firmware, ML pipeline, agentic system, CLI, library, hardware controller, financial model, something else.
2. **What are the distinct subsystems a developer would think about separately while building?** Database vs API vs UI; or kernel vs renderer vs assets; or HAL vs drivers vs protocols; or agent loop vs tools vs memory.
3. **Are there cross-cutting product concerns that warrant their own layer?** Auth, integration, testing, docs, safety.
4. **Pick 4 to 8 names. Stop.** More is sprawl. Fewer is no signal.

### Hard rules

- 4 to 8 categories per project.
- The list is server-enforced: `piyaz_create`, `piyaz_edit`, and project-scoped `piyaz_search` reject a category outside the project's vocabulary and name the valid set inline. Read it via `piyaz_get project view='meta'`; extend it deliberately via `piyaz_workspace action='update' categories=[...]`, never by coining mid-task. Rename or remove an in-use entry only via `action='rename_category'` / `action='delete_category'` (they move or uncategorize the tasks atomically); rewriting the array does not touch task rows and orphans them.
- Architectural layer / product area / subsystem only. Not process phases (`requirements`, `planning`, `review`). Not work types (`bugs`, `features` are tags, not categories). Not priorities.
- **Test: would this be a tag in some other project shape?** If yes, it's cross-cutting, not a category. Quality attributes (`security`, `perf`, `a11y`, `reliability`, `observability`, `dx`, `compliance`, `safety`) and multi-category feature clusters (`onboarding-flow`, `agent-loop`, `flight-control`, `inference-pipeline`, `dashboard-refresh`) belong in the tag dimension. Categories are subsystems the project shapes itself around: directories, build targets, layers a developer thinks about separately. §2 and §4 are mirrors. A name passes one test, not both.
- Nouns. `data` not `data-modeling`. `ui` not `ui-work`.
- Pick once at creation. Mid-project additions miscategorize earlier tasks. Resist.
- Decompose and onboarding agents must surface their proposed categories at the gate. No silent application.

### Forbidden categories

- `requirements`, `architecture`, `planning`, `review`, `refinement`: process phases, not subsystems.
- `bugs`, `features`, `improvements`: work types. Use the `tags` work-type dimension.
- `important`, `critical`, `priority`: use the `priority` field.
- `frontend-work`, `backend-stuff`: drop the suffix.
- `open-questions`, `tbd`, `misc`: resolve them with proper tasks, do not give them a drawer.

### Common starting points

These are familiar starting sets, not a canonical menu. Borrow when nothing in the project description demands a different shape. Replace with project-specific names (`flight-control`, `pricing`, `agent-loop`) when the project has different layers.

| Category | Use for |
|---|---|
| `setup` | Scaffolding, project init, CI/CD, build system |
| `infra` | Deployment, hosting, monitoring, observability infra |
| `data` | Schema, migrations, persistence, seed |
| `auth` | Authentication, authorization, RBAC, secrets |
| `api` | Backend endpoints, request validation, server-side logic |
| `ui` | Frontend components, pages, UX |
| `core` | Domain logic, business rules, kernel, engine internals |
| `sdk` | Library code, client SDKs, public surface |
| `cli` | Command-line interface, internal tooling |
| `integration` | Third-party services, webhooks, plugins, external APIs |
| `testing` | Test infrastructure, fixtures, evals, QA |
| `docs` | Documentation, examples, guides, release notes |

### Project-type guidance

Defaults that match the actual architecture of common project shapes. Adapt to what the specific project is doing.

- **Web / SaaS**: `setup`, `data`, `auth`, `api`, `ui`, `integration`, `testing`, `docs`.
- **Mobile (iOS / Android)**: `setup`, `data`, `auth`, `screens`, `services`, `native`, `testing`.
- **Game / engine**: `core`, `rendering`, `physics`, `audio`, `assets`, `ai`, `netcode`.
- **Simulation / scientific**: `core`, `models`, `io`, `scenarios`, `verification`, `docs`.
- **Embedded / firmware**: `hal`, `drivers`, `protocols`, `bootloader`, `testing`, `docs`.
- **ML / data platform** (production ML systems with training and serving): `data-pipeline`, `training`, `inference`, `evaluation`, `serving`.
- **Data warehouse / analytics engineering** (dbt project, SQL marts, transformations): `sources`, `staging`, `marts`, `metrics`, `tests`, `docs`. Add `pipelines` if Airflow/Dagster orchestration is its own surface; `seeds` if reference data has a meaningful footprint.
- **Business analyst / BI** (dashboards, reports, ad-hoc analysis, stakeholder deliverables): `requirements-intake`, `analysis`, `dashboards`, `metrics`, `data-quality`, `documentation`. Add `stakeholders` if recurring stakeholder reviews are first-class; `playbooks` if reusable analysis templates are part of the deliverable. Note: `requirements-intake` here is a product surface (BRDs, stakeholder asks tracked as artifacts), not the forbidden process-phase `requirements`.
- **Mixed dbt-shop + BI delivery** (a dbt rebuild that ships into stakeholder-owned BI dashboards, common when Finance / Sales / Marketing trust degrades and the fix is one source of truth fed into existing tools): merge the two vocabularies. Common landing: `sources`, `staging`, `marts`, `metrics`, `dashboards`, `data-quality`, `governance`. Pick `tests` over `data-quality` if testing has its own surface; `documentation` over `governance` if change-management is light.
- **Agentic system / app** (an LLM loop with tools and memory): `core` (agent loop, planner, orchestration), `tools` (function calling, MCP, capability adapters), `memory` (context, state, long-term storage), `models` (LLM client, routing, caching), `evals` (scenarios, regression harness), `safety` (guardrails, output validation). Add `ui` if there is a chat or dashboard surface; `prompts` if prompt engineering is its own discipline.
- **Multi-agent system** (orchestrator + worker agents, tools shared): `orchestration` (planner, scheduler, routing), `agents` (worker agent definitions), `tools`, `memory`, `models`, `evals`, `safety`.
- **Financial / quant**: `models`, `pricing`, `risk`, `reporting`, `data`, `ui`.
- **Library / SDK / CLI**: `core`, `api`, `cli`, `examples`, `testing`, `docs`.
- **Hardware / aerospace / defense**: borrow from embedded plus domain layers like `flight-control`, `telemetry`, `safety`, `mission-planning`, `comms`.
- **Hackathon / throwaway**: 4 categories or fewer. Do not over-decompose.

---

## 5. Granularity

**1 to 4 hours per task.** A coding agent should complete one in a single session.

> **Starting count is not a cap.** The numbers below are seed values for decompose / onboarding, not enumeration of every task that will ever exist. Real projects accumulate tasks as work materializes; teams add tasks every day. When a parent agent or a test rig caps the task count below the table's range, honor the cap and document the deviation in your transcript or local working file.

| Project size | Starting task count |
|---|---|
| Hackathon / 1-day spike | 5 to 10 |
| Simple (≤5 features, single user role) | 10 to 20 |
| Medium (5 to 15 features, several roles) | 20 to 40 |
| Complex (15+ features, multiple subsystems) | 40 to 80 |
| Enterprise / multi-team / long-running | 60 to 120 foundation tasks. The graph grows organically into the hundreds or thousands as teams add work. |

Too small (under 30 minutes): overhead exceeds work.
Too large (over 1 day): hidden subtasks, unclear scope, hard to track.

When in doubt, split. Tasks become more useful, and more parallelizable, as they shrink toward the 1-hour mark.

---

## 6. Markdown formatting and tone

Applies to `description`, `acceptanceCriteria`, `executionRecord`, `implementationPlan`, `decisions`, and edge `note`. Not to `files` (plain paths) or `tags` (kebab-case).

### Structure

- Bullet lists (`-`) for 3 or more items. Never run-on prose.
- Backticks for code references: file paths, function names, endpoints, variables, package names.
- Paragraph breaks between distinct topics.
- Headings (`##`, `###`) only in long fields like `implementationPlan` and the executionRecord's optional `Deliverables` section.

### Tone: never sound like AI

The text you write into Piyaz is read by other engineers. It must read like an engineer wrote it, not a chatbot.

**Do not use:**

- Em dashes (the `—` character). Use periods, commas, parentheses, or colons.
- Hedging openers: "I think", "perhaps", "seems to", "might be", "arguably".
- Enthusiasm: "Great question", "Awesome", "Exciting", "Love this".
- Throat-clearing: `Let me dive into`, `I hope this helps`, `Here's the thing`, `To be honest`.
- Marketing words: `comprehensive`, `robust`, `powerful`, `leverage`, `utilize`, `ensure`, `facilitate`, `seamless`, `game-changer`, `best-in-class`.
- Adverb-heavy openers: "Importantly", "Crucially", "Notably", "Essentially", "Basically".
- Empty filler: `It's worth noting that`, `It should be mentioned`, `As a matter of fact`.
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
