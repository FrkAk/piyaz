# Piyaz artifact quality

The quality bar for what an agent writes into a task: titles, descriptions, acceptance criteria, files, tags, edges, categories, and sizing. Read it when about to create, refine, or audit an artifact.

The Iron Law of grounding ([conventions.md](conventions.md) §1) applies at every step. The *written shape* of the long-form artifacts (implementation plans, execution records, decisions, notes, PR bodies) lives in [specs/contracts.md](specs/contracts.md); how the prose sounds lives in [role.md](role.md).

## Contents

- §1 Task artifact quality: title, description, acceptanceCriteria, files
- §2 Tag dimensions and first-class fields (priority, estimate, assignees)
- §3 Edge types and decision criteria
- §4 Categories: selection walkthrough, hard rules, forbidden list, project-type guidance
- §5 Granularity: task sizing and starting counts
- §6 Markdown and tone: see specs/contracts.md and role.md

---

## 1. Task artifact quality

### Title

Verb plus noun, imperative.

```
GOOD: "Implement JWT auth"
GOOD: "Fix Queue::front returning a copy"
GOOD: "Train baseline ResNet on internal dataset"

BAD: "Auth"
BAD: "Queue stuff"
BAD: "Performance"
```

### `description`

The first thing a coding agent or engineer reads when picking up a task, and enough on its own to start the work.

Cover, depending on task type:

- **Feature:** what the capability does, who it serves, where it lives in the architecture.
- **Bug:** what is broken, when it manifests, why it matters, and the suspected root cause if known.
- **Refactor:** what changes, what stays the same, why it is worth doing now.
- **Research:** what the question is, why it needs answering, what a good answer looks like.
- **Chore, setup, docs:** what needs doing and why now.

Include a solution sketch when you have one: "Use Drizzle, mirror the patterns in `lib/data/task.ts`" beats "Define the database tables". Do not pad with implementation guesses when the approach is uncertain; the implementation plan is for that.

Length follows content: cover the points above for the task's type in plain markdown, paths and symbols as code spans, and cut filler rather than clarity. Single-sentence descriptions are never acceptable; the server flags them in `_hints` and they get rewritten before moving on.

**For onboarding**, writing descriptions for tasks that already shipped: write as if the task were being created before the work, knowing what you now know about the codebase. The reader must be able to re-derive the work from the description. Not "added the auth middleware" but "Build the JWT auth middleware in `lib/auth/middleware.ts`. Validate Bearer tokens against the user table, set `req.user`, reject on expiry. Required by every protected route."

```
GOOD (feature, web SaaS):
"Build the habit completion endpoint at POST /api/habits/:id/complete. Inserts
into habit_logs with the user's timezone-adjusted date. Returns the updated
streak count. Idempotent on (habit_id, log_date): duplicate calls return the
existing log. Used by both the web dashboard and the iOS widget."

GOOD (data / dbt model build):
"Build the daily_active_users dbt model in models/marts/engagement/. Reads
from stg_events.session_started, deduplicates on (user_id, date_trunc('day',
event_ts)), excludes internal traffic via is_internal flag from dim_users.
Materializes incremental on event_date with a 7-day lookback window. Used by
the Looker `Engagement Overview` dashboard and the weekly stakeholder report."

BAD: "Improve the database."
BAD: "Make auth better."
BAD: "Build the dashboard."
```

### `acceptanceCriteria`

Each criterion is one binary check: a reviewer answers yes or no without asking anything. Compound checks split into separate criteria; most tasks need only a handful.

```
GOOD (web):
- "Running bun run db:push creates all tables without errors"
- "FK from tasks.projectId to projects.id with ON DELETE CASCADE"
- "Seed script creates 3 test users and 2 projects with tasks"

GOOD (data / dbt):
- "dbt run --select daily_active_users completes in under 90s on prod warehouse"
- "Row count on 2026-05-01 matches stg_events session count to within 0.1%"
- "dbt test passes: not_null on user_id and event_date, unique on the pair"

BAD:
- "Database works"
- "Tests pass"
- "Performance is good"
- "Numbers match"
```

Single-criterion tasks get flagged by the server in `_hints`; rewrite them. Vague criteria ("works correctly", "is complete", "performs well") get rewritten before planning.

### `executionRecord` and `decisions`

Both carry a fixed written shape: [specs/contracts.md](specs/contracts.md). The record belongs only on `in_review`, `done`, and `cancelled` tasks; a `draft` task carrying one claims it shipped.

### `files`

Plain repo-relative path strings, no backticks and no quoting. Cover every file created or modified. `files=[]` is the correct positive value whenever paths cannot be cited: pre-implementation tasks where the code does not exist yet, research or decision-only tasks, Piyaz-only refinements. Leave it empty rather than speculate.

---

## 2. Tag dimensions and first-class fields

Every task, in every status, carries tags across the three dimensions below. Reuse existing tags from `piyaz_get project='<identifier>' view='meta'` before coining new ones.

| Dimension | Count | Vocabulary |
|---|---|---|
| **Work type** | exactly 1 | `bug`, `feature`, `refactor`, `docs`, `test`, `chore`, `perf` |
| **Cross-cutting concern** | 1 or more | a quality attribute (`security`, `a11y`, `dx`, `perf`, `reliability`, `observability`, `i18n`, `compliance`, `safety`) or a feature cluster spanning several categories (web: `onboarding-flow`, `live-replay`; aerospace: `flight-control`, `mission-planning`; agentic: `agent-loop`, `eval-harness`; ML: `inference-pipeline`, `data-drift`) |
| **Tech** | at most 2 | the most important stack pieces the task touches, pulled from manifest deps |

### First-class fields

These are top-level columns, set at creation through `piyaz_create` item fields or later through `piyaz_edit`. They are not tags.

- **`priority`**, one of `urgent`, `core`, `normal`, `backlog`. Pick deliberately. Onboarding lands shipped features at `core`; decompose picks per task and avoids `core` everywhere or `urgent` everywhere, since the dimension carries no signal then. A 30-task project usually has 3 to 6 `urgent` tasks and the rest split across the others.
- **`estimate`**, Fibonacci story points `1`, `2`, `3`, `5`, `8`, `13`. Optional. `1` is trivial, `2` and `3` routine, `5` nontrivial, `8` and `13` risky or multi-day. A task that feels larger than `13` gets split (§5).
- **`assigneeIds`**, team-member user UUIDs. Optional. Declares ownership and intent, not concurrent execution; the single-worker `in_progress` invariant still holds. Each id must belong to the project's owning team, and the server rejects non-members at write time. Discover UUIDs via `piyaz_workspace action='members'`.

**Do not tag:** priority (that is the `priority` field), codebase area (that is `category`), task status (that is `status`), or generic adjectives like "important" and "primary".

**The area test:** would this name plausibly be a category in some other project shape? `render-loop`, `effect-system`, `auth`, `payments`, `inference`, `marts`, `flight-control`, `hal-drivers` all answer yes, so they are subsystems even if your project's category list happens to omit them. Tags are the axes a project does not shape itself around: quality attributes and multi-category feature clusters. Coining an area-shaped tag because the categories lack a good slot is a category-list bug, not a tag.

**Honoring user-specified tags:** preserve what the user tagged explicitly, and add whichever of the three dimensions are missing.

**Tech tags by domain:** web (`react`, `next`, `drizzle`, `postgres`), embedded (`c`, `rust`, `freertos`, `zephyr`), ML (`pytorch`, `jax`, `triton`), data and BI (`sql`, `dbt`, `snowflake`, `looker`, `airflow`). Pull them from the project's actual stack; do not invent.

---

## 3. Edge types and decision criteria

Two types: `depends_on` (source needs target done first) and `relates_to` (informational link).

Use `depends_on` when the source cannot start or complete without the target's output: it needs code, APIs, or schema the target produces, or decisions and configuration the target defines. Use `relates_to` when tasks share context but neither blocks the other: they touch the same area but can be built independently, or one's decisions are useful context rather than a prerequisite.

**The litmus test:** if removing the target makes the source impossible, it is `depends_on`. If it only makes it harder or less informed, it is `relates_to`.

Edge notes propagate into coding-agent context, so write each one as a brief to the developer about to start the source task: what specifically does this task get from the target? Empty notes are not notes.

```
GOOD (web): "User API endpoints need the JWT middleware and token
validation helpers built in the auth task. See lib/auth/middleware.ts."

GOOD (embedded): "BMP280 sustained-read fix depends on the i2c
clock-stretch patch in firmware-22. Without it the sensor returns 0xFF."

GOOD (data): "Looker `Engagement Overview` dashboard depends on the
daily_active_users dbt model. Tile queries select from the marts schema
and break if the model is renamed or its grain changes."

BAD: "needs auth"
BAD: "depends on this"
BAD: "related"
```

---

## 4. Categories

Categories drive drawer grouping in the UI, and every task gets exactly one. They are set in exactly four moments: at project creation, during decompose as part of the Phase 1 plan presented before any write, during onboarding as part of the Phase 3 proposal, and when the user asks to add or remove one. Never coin one silently mid-decompose, mid-onboarding, or while creating an ad-hoc task; the list is project scaffolding, and sprawl here pollutes every overview forever.

### Choosing them

You are naming the architectural layers, product areas, and subsystems of one project.

1. **What does the project do at a high level?** Web app, mobile app, game, simulation, firmware, ML pipeline, agentic system, CLI, library, hardware controller, financial model, something else.
2. **What subsystems would a developer think about separately?** Database vs API vs UI; kernel vs renderer vs assets; HAL vs drivers vs protocols; agent loop vs tools vs memory.
3. **Any cross-cutting product concerns warranting their own layer?** Auth, integration, testing, docs, safety.
4. **Pick 4 to 8 names and stop.** More is sprawl, fewer is no signal.

### Hard rules

- 4 to 8 categories per project.
- The list is server-enforced: `piyaz_create`, `piyaz_edit`, and project-scoped `piyaz_search` reject a category outside the vocabulary and name the valid set inline. Read it with `piyaz_get project view='meta'` and extend it deliberately with `piyaz_workspace action='update' categories=[...]`, never by coining mid-task. Rename or remove an in-use entry only through `action='rename_category'` or `action='delete_category'`, which move or uncategorize the tasks atomically; rewriting the array leaves task rows untouched and orphans them.
- Architectural layer, product area, or subsystem only. Not process phases (`requirements`, `planning`, `review`), not work types (`bugs`, `features` are tags), not priorities.
- **The mirror of §2's area test:** would this be a tag in some other project shape? If yes it is cross-cutting, not a category. A name passes one test, not both.
- Nouns: `data` not `data-modeling`, `ui` not `ui-work`.
- Pick once at creation. Mid-project additions miscategorize earlier tasks.
- Decompose and onboarding surface their proposed categories at the gate. No silent application.

### Forbidden

- `requirements`, `architecture`, `planning`, `review`, `refinement`: process phases, not subsystems.
- `bugs`, `features`, `improvements`: work types, so use the tag dimension.
- `important`, `critical`, `priority`: use the `priority` field.
- `frontend-work`, `backend-stuff`: drop the suffix.
- `open-questions`, `tbd`, `misc`: resolve them with proper tasks rather than giving them a drawer.

### Project-type guidance

Defaults matching the actual architecture of common shapes, not a canonical menu. Borrow when nothing in the description demands a different shape, and replace with project-specific names (`flight-control`, `pricing`, `agent-loop`) when the project has different layers. The recurring generic slots: `setup` (scaffolding, init, CI/CD), `infra` (deploy, hosting, observability), `data` (schema, migrations, seed), `auth`, `api`, `ui`, `core` (domain logic, engine internals), `sdk`, `cli`, `integration` (third-party, webhooks), `testing`, `docs`.

- **Web / SaaS:** `setup`, `data`, `auth`, `api`, `ui`, `integration`, `testing`, `docs`.
- **Mobile:** `setup`, `data`, `auth`, `screens`, `services`, `native`, `testing`.
- **Game / engine:** `core`, `rendering`, `physics`, `audio`, `assets`, `ai`, `netcode`.
- **Simulation / scientific:** `core`, `models`, `io`, `scenarios`, `verification`, `docs`.
- **Embedded / firmware:** `hal`, `drivers`, `protocols`, `bootloader`, `testing`, `docs`.
- **ML / data platform** (training plus serving): `data-pipeline`, `training`, `inference`, `evaluation`, `serving`.
- **Data warehouse / analytics engineering** (dbt, SQL marts): `sources`, `staging`, `marts`, `metrics`, `tests`, `docs`. Add `pipelines` when orchestration is its own surface, `seeds` when reference data has a real footprint.
- **Business analyst / BI:** `requirements-intake`, `analysis`, `dashboards`, `metrics`, `data-quality`, `documentation`. Add `stakeholders` when recurring reviews are first-class, `playbooks` when reusable templates ship. `requirements-intake` here is a product surface (BRDs, stakeholder asks as artifacts), not the forbidden process phase.
- **Mixed dbt plus BI delivery:** merge the two, commonly `sources`, `staging`, `marts`, `metrics`, `dashboards`, `data-quality`, `governance`.
- **Agentic system:** `core` (agent loop, planner), `tools` (function calling, MCP), `memory`, `models` (client, routing, caching), `evals`, `safety`. Add `ui` for a chat surface, `prompts` when prompt engineering is its own discipline.
- **Multi-agent system:** `orchestration`, `agents`, `tools`, `memory`, `models`, `evals`, `safety`.
- **Financial / quant:** `models`, `pricing`, `risk`, `reporting`, `data`, `ui`.
- **Library / SDK / CLI:** `core`, `api`, `cli`, `examples`, `testing`, `docs`.
- **Hardware / aerospace:** embedded plus domain layers like `flight-control`, `telemetry`, `safety`, `mission-planning`, `comms`.
- **Hackathon / throwaway:** 4 categories or fewer. Do not over-decompose.

---

## 5. Granularity

**One task, one reviewable PR.** Size a task so a coding agent can understand the bundle, research the unknowns, clarify what is ambiguous, and deliver the result as one PR a reviewer evaluates in one sitting: one concern, its tests, nothing half-delivered. That usually lands at 1 to 4 focused hours of work; the PR is the test, the hours are the symptom.

Starting counts calibrate decompose and onboarding; they are not targets in either direction. Real projects accumulate tasks as work materializes. When a parent agent or a test rig caps the count below this table, honor the cap and record the deviation in your transcript or local working file.

| Project size | Starting task count |
|---|---|
| Hackathon / 1-day spike | 5 to 10 |
| Simple (5 or fewer features, single role) | 10 to 20 |
| Medium (5 to 15 features, several roles) | 20 to 40 |
| Complex (15+ features, multiple subsystems) | 40 to 80 |
| Enterprise / multi-team | 60 to 120 foundation tasks, growing into the hundreds as teams add work |

Under 30 minutes of work, fold it into the PR it belongs to; two thin PRs cost more review than one coherent change. Over a day and you have hidden subtasks, unclear scope, and something hard to track: split at the seams a reviewer can evaluate independently, which is also where parallel agents stop colliding.

---

## 6. Markdown and tone

Structure (headings, code spans, lists, tables) lives in [specs/contracts.md](specs/contracts.md). Voice and the words to avoid live in [role.md](role.md). Both are sole copies.
