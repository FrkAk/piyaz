# Piyaz workflows

Full step lists for the workflows the router in `SKILL.md` indexes. Read the entry you are running, not the file.

Tool shapes and costs: [tools.md](tools.md). Artifact shapes: [specs/contracts.md](specs/contracts.md). Status rules: [lifecycle.md](lifecycle.md).

## Session detection

1. `piyaz_workspace action='projects'`.
2. Derive the repo identity from the git remote, the package name, and pwd.
3. If a project's title or description matches, use that identifier with the workflows below.
4. Otherwise, if the repo has commits or source files, confirm with the user, then dispatch `piyaz:onboarding`. If it has neither, treat it as a net-new conversation and run the brainstorm playbook.

Notes:

- `action='projects'` returns title, identifier, status, and counts for every team, cheap enough to call once per session. Descriptions and tag vocabulary come on demand from `view='meta'`. Never run `view='overview'` across projects; at most on the one you settle on.
- `action='teams'` runs later: at create time, when `projects` comes back empty, or when the user names a team it did not surface.
- **Match definition.** The package name or git remote URL appears in the project title, case-insensitive, as a whole word. On ambiguity read `view='meta'` on a candidate, or ask. Do not stall.
- **Confirmation gate before brainstorm or decompose.** Scan `projects` for a title overlapping what the user described. On weak overlap read `view='meta'` to verify scope, then ask: "I see `<project title>` in `<team>`; is this the one, or are you starting fresh?" Decomposing on top of a project that already covers the scope is the worst-case waste, and one prompt prevents it. Skip the gate only when the user named a project explicitly or `projects` is empty.
- **Onboarding is gated.** Repo has code, no matching project: surface it ("This repo doesn't match any of your existing projects; should I run onboarding to import it?") and wait for an explicit yes. Onboarding writes data and takes time.
- **Non-repo workspaces.** Data and BA work often has no code repo: a Snowflake worksheet collection, a Looker workspace, a BRD library. Skip repo identity derivation, ask which project the workspace maps to, and route to brainstorm for net-new or to the named project otherwise. Onboarding still applies when the workspace holds structured artifacts (a `dbt_project.yml`, a SQL repo, dashboard exports, a notebook tree).

## Status: what is the state?

1. `piyaz_map view='ready'`. Unblocked work, usually the only thing the user cares about.
2. `piyaz_map view='blocked'`. What is stuck and behind what.
3. Nothing ready: `piyaz_map view='plannable'` for drafts ready to plan.
4. Bottleneck asked for: `piyaz_map view='critical_path'`.
5. Scoped question ("how is the auth work going?"): `piyaz_search query='auth'` or `tags=['auth']` with `project='<identifier>'`.
6. Summarize progress, blockers, and one recommendation, naming tasks by ref.

Do not open with `view='overview'`. It returns every task and edge and dominates context even budgeted. It belongs in resume when the user explicitly wants the whole graph, and in the manage agent's strategic review.

## What should I work on?

1. `piyaz_map view='ready'`.
2. `piyaz_map view='critical_path'`. Tasks on the chain set the minimum project duration, so if you run one map view alongside `ready`, run this one.
3. **Ready tasks exist:** recommend one at the intersection of `ready` and `critical_path`, the highest-impact unblocked work. Once the user picks, claim it with `piyaz_edit task='<ref>' operations=[{op:'set', field:'status', value:'in_progress'}]`, then `piyaz_get task='<ref>' lens='agent'` and hand off.
4. **No ready tasks:** `piyaz_map view='plannable'`, pick one on the critical path, and run *Plan a draft task*.

For end-to-end automation across the queue, suggest `/piyaz:composer` in backlog mode: it picks the highest-value ready task each iteration, drives it through the full pipeline in per-phase contexts, and loops without per-task check-ins, gating only on genuine decisions (oversize tasks, proposed rewrites, open questions). Use it when the user wants the queue shipped; use the picker above when they want per-task agency.

## Continue, resume, guide me forward

Covers explicit "continue" and "resume" as well as open-ended "what should I focus on", "I'm stuck, where next", "give me a path forward".

1. `piyaz_workspace action='projects'` if you have not run it this session.
2. **If you know when you left off:** `piyaz_activity project='<identifier>' since='<last known instant>'`, newest first. Follow the refs that moved.
3. `piyaz_get project='<identifier>' view='meta'` for progress, status, description, categories, tag vocabulary. Skip it if step 1 ran this turn; `projects` already carries per-project progress.
4. **Lead with `piyaz_map view='critical_path'`.** The longest chain is the shape of the remaining work.
5. `piyaz_map view='ready'`, then `view='blocked'`, then `view='plannable'` if still nothing actionable.
6. Specific lookups: `piyaz_search`. One task's relationships: `piyaz_map view='neighbors'`.
7. Reach for `view='overview'` only if the user explicitly wants every task and edge, once per session.
8. Summarize progress, the critical path's current head, and one concrete recommendation. Do not dump the task list.

After compaction or a long gap, [resilience.md](resilience.md) §4 covers resume before any write phase.

## Refine a task

1. `piyaz_get task='<ref>' lens='working'`. Current state, edges, and the item ids every by-id edit needs.
2. Explore before proposing: related tasks by tag or title fragment, current docs for any framework it touches, the codebase for what already exists. If you do not know, look; if you cannot find it, ask. Refining on assumptions is how vague tasks survive review.
3. Improve description, criteria, decisions, and dependencies. Single-sentence descriptions and "works correctly" criteria get rewritten before saving.
4. `piyaz_edit task='<ref>'` with surgical ops: `str_replace` after fetching the exact text via `fields=['description']`, `add` for new criteria and decisions, `update` or `remove` by id. Prefer these over `set` on a text field, which replaces wholesale with no undo.
5. Propagate if decisions changed.

## Plan a draft task

1. `piyaz_get task='<ref>' lens='planning'`. Spec, prerequisites, work so far, related work.
2. Write the plan. If plan mode produced a file, read it and use the full content. Otherwise do the work yourself: search the codebase, read current docs for any new dependency, clarify open questions, reason through edge cases. File paths, line numbers, specific changes, verification steps. Shape: [specs/contracts.md](specs/contracts.md).
3. `piyaz_edit task='<ref>' operations=[{op:'set', field:'implementationPlan', text:'<full markdown>'}, {op:'set', field:'status', value:'planned'}]`. One atomic call carrying the complete unabridged plan and the status flip. Do not summarize the plan.

## Implement a task and record completion

0. If the task is `draft`, plan it first.
1. Claim it: `piyaz_edit task='<ref>' operations=[{op:'set', field:'status', value:'in_progress'}]`.
2. `piyaz_get task='<ref>' lens='agent'`. Multi-hop dependencies, upstream execution records, related tasks, criteria.
3. Understand before doing. Read the description, the upstream execution records, and the relevant code. Reason about what could go wrong, ask if anything is unclear, then implement. Rushing here produces work that misses the actual requirement.
4. Detect your mode before the terminal write ([lifecycle.md](lifecycle.md) §2.1). Dispatched, meaning a parent agent is visible in your transcript: mark `in_review` directly. Direct: ask first.
5. **If the work changed code, open the PR first.** Detect a PR template, fill it concisely from the executionRecord and the criteria, and use the bracket form for the primary task ref (`[EWA-31]`) so Piyaz tracks PR status. Skip sections you have nothing to say about. Full rules and the default body: [specs/contracts.md](specs/contracts.md).
6. **One `piyaz_edit` call carries the whole Completion Protocol payload:** `set executionRecord`, one `add` per decision, `set files`, `check` / `uncheck` each acceptance criterion by its id (evaluated against the work, never auto-checked), `set prUrl` when a PR was opened (the backend upserts a `task_links` row with `kind='pull_request'` so the review subagent and the detail UI can resolve the PR), and `set status='in_review'`. Read the response `_hints` and re-call with anything missing. After the PR is approved, the HOTL operator flips `in_review → done`. Agents do not self-promote.
7. **Propagate** ([lifecycle.md](lifecycle.md) §3): `piyaz_map view='neighbors' task='<ref>'`, then `piyaz_map view='downstream' task='<ref>'`. Update, create, or remove edges via `piyaz_link`.

For automation on one task, suggest `/piyaz:composer <taskRef>`, which drives it through the same pipeline in per-phase contexts. When HOTL requests changes on a composer PR instead of merging, `/piyaz:composer rework <taskRef|pr-url>` rounds that feedback back through the fix loop.

## Mark a task done (user reports completion)

The user is the HOTL operator: their explicit "mark it done" is the authorized transition, not agent self-promotion. Execute it with honest fields. The self-promotion ban covers agents promoting their own work without a user order.

1. `piyaz_search query='<ref or title>'`. Find it.
2. If it is not `in_progress`, set it first. This preserves lifecycle history.
3. If the task is already at `in_review`, the implementer populated executionRecord, decisions, files, and criteria. The only operator action left is the flip to `done`. Skip the field collection below and go to propagation.
4. Collect details. Extract them from the conversation if the user described the work, ask if they only said "done", or summarize the agent's report if a coding agent did the work. If the user forbids questions ("don't ask me anything", "just mark it"), that waives the question and never the Iron Law: proceed with the status change, since the explicit order is the confirmation, but write only what you can cite. When that is nothing, the honest record is "Marked done on the user's report; no implementation details provided", and you tell the user which fields still need their input. Never pad the record with content re-derived from the task's own description; that is fabrication ([conventions.md](conventions.md) §1).
5. Evaluate each acceptance criterion by id. `check` only with evidence you can cite: the conversation, a diff, the code, an agent's report. No evidence means it stays unchecked, even when the user says "check all the boxes".
6. One `piyaz_edit` call with every required op: `set executionRecord`, `add` decisions, `set files`, the criterion checks, `set prUrl` when a PR exists, and `set status='done'`. Open the PR if applicable, then propagate.

## Review an `in_review` task or a PR

The direct-mode counterpart to composer Phase 4. Use it on "review DRF-26", "review this PR", "review `<PR URL>`", "what does the review subagent think of DRF-26", or any request for a structured verdict on work that already landed at `in_review`.

1. **Resolve the target.**
   - Given a taskRef: `piyaz_get task='<taskRef>' lens='summary'`. Surface its status in your response.
   - Given a PR URL with no taskRef: parse the bracketed ref (`[CMP-104]`) from the PR title (`gh pr view <num> --json title`) and resolve the task from there. When the title carries no bracket, ask which task it ships.
2. **Confirm `status='in_review'`.** Anything else means the dispatch is premature (`in_progress` work is not reviewable) or archaeological (`done` / `cancelled`). Flag it and ask whether to proceed.
3. **Dispatch the review subagent.** One Task call with `subagent_type='piyaz:review'`. Prompt body:

   ```text
   Target task: <taskRef>
   PR URL: <url>
   Mode: direct-review
   Fetch the bundle via piyaz_get task='<taskRef>' lens='review'.
   ```

   The PR URL is optional when `task.links` already carries a `kind='pull_request'` entry. Pass it when you have it, to keep the dispatch self-contained.
4. **Surface the verdict verbatim.** The reviewer returns `approve`, `request-changes`, or `block` with file-cited reasoning per lens, criteria evaluation, plan-versus-diff drift, and downstream impact. Do not paraphrase and do not auto-act. The verdict is advisory; HOTL still owns `in_review → done` on GitHub.
5. **Optional follow-up.** If the downstream-impact section flags edges that need attention, run propagation ([lifecycle.md](lifecycle.md) §3). Do not flip status based on the verdict.

## Dispatch coding agents in parallel

Use this when several independent ready tasks exist and several coding agents, sessions, or workers are available at once. Tasks ship faster, you coordinate, each agent works in isolation.

1. **Find independent ready tasks.** `piyaz_map view='ready'`. Two tasks both in `ready` cannot block each other by definition.
2. **Sanity-check independence at the file level.** Two ready tasks both editing `lib/auth/middleware.ts` will conflict. On overlap, either serialize them or split the shared change into a third task that lands first. Give each agent an isolated workspace, one git worktree per agent where the platform supports it, since two agents sharing a working tree corrupt each other's diffs even without file overlap.
3. **Rank by critical-path proximity.** `piyaz_map view='critical_path'`. With 3 agents and 6 ready tasks, send them to the 3 critical-path tasks first.
4. **Claim and hand off.** Per task: claim via `piyaz_edit` (`set status='in_progress'`, which stops two agents grabbing the same task), then `piyaz_get task='<ref>' lens='agent'` for the context. Hand it over and brief the agent that it is dispatched.
5. **Each agent marks `in_review` directly**, no asking: executionRecord, decisions, files, criteria, `in_review`, a PR if code changed, and a one-sentence summary back.
6. **Review and finalize.** Review the returned records and PRs, flip approved tasks `in_review → done`, and propagate each.
7. **More agents than ready tasks?** Send the surplus to plan draft tasks. Planning parallelizes too.

## Dispatch protocol

A coding subagent and the review subagent behave as described above: the implementer marks `in_review` directly with the full payload as its terminal write, the reviewer stays read-only and returns a verdict you surface verbatim. The third case is a **meta-agent** (`piyaz:brainstorm`, `piyaz:decompose`, `piyaz:decompose-task`, `piyaz:decompose-feature`, `piyaz:onboarding`, `piyaz:manage`): each has its own gates and reporting style in its agent file, the Completion Protocol applies only when it marks a task done itself, so brief it on intent and trust its phase-gating.

## Create a project

1. `piyaz_workspace action='teams'`. Run it even when `projects` already showed projects: empty teams do not appear there, and the user may want the project in one.
2. Multi-team account with an ambiguous target: ask, do not default. The server rejects ambiguous creates with the team list inline.
3. Pick 4 to 8 categories from [artifacts.md](artifacts.md) §4, matched to the project's actual shape.
4. `piyaz_workspace action='create' title='<verb+noun>' description='<purpose, stack, key constraints>' categories=[...] organizationId='<team-uuid>'`.
5. Then create tasks, run the decompose playbook, or dispatch `piyaz:decompose`.

## Create tasks

0. Read `piyaz_get project='<identifier>' view='meta'` for existing categories and tag vocabulary with usage counts. Reuse before coining.
1. `piyaz_create project='<identifier>'` with each task carrying title, description, criteria, one category from the project's list, three tag dimensions, and `priority` (optionally `estimate`, `assigneeIds`). Quality bar: [artifacts.md](artifacts.md) §1-§2. Related tasks go in one batch call with their internal `key`-addressed edges: atomic, idempotent, one round trip.
2. Wire edges to existing tasks in the same call (`source` / `target` take taskRefs) or afterwards via `piyaz_link`, searching precedents by verb, noun, and surface. Notes must be substantive ([artifacts.md](artifacts.md) §3). Bare tasks orphan from `critical_path`, `downstream`, and agent-context propagation.
3. Verify with `piyaz_map view='neighbors' task='<new ref>'`.

## Delete or cancel a task

- **Cancel** when the rationale is worth keeping: an abandoned approach, deprioritized scope, a superseded design, a PR closed without merge. `piyaz_edit task='<ref>'` with `set executionRecord` (why abandoned and what was tried), `add` decisions, and `set status='cancelled'`. Then propagate.
- **Delete** when the task is noise: accidental, wrong project, duplicate, never had content. `piyaz_edit` with the single op `{op:'delete_task'}`, which previews by default. Show the impact, get confirmation, then re-run with `preview=false`.

Edges to a cancelled task remain in place, and cancellation is transitive-aware: dependents stay blocked through the cancelled task's own unsatisfied prerequisites.

## Brainstorm inline

For clear specs handled in a few exchanges. Parse what the user said, list what is covered (idea, user, features, tech, scope, user flow), and ask only about gaps, one focused question per turn. Push back on weak choices with examples sized to the domain: "30 features for a 3-month solo project: which 5 ship without?", "rolling custom auth: which existing library doesn't work for you?", "spawning a fresh agent per request: what can't be reused from the parent's context?"

When ready:

1. Synthesize: summary, target user, feature list with priority hints, tech stack, risks, out of scope.
2. **Gate: present the synthesis and wait for an explicit "yes, proceed" or "approved" before any write.** Hedging ("looks fine", "sure", "I trust you", "I'm in a hurry") is not approval.
3. If the user is non-technical or asks what you would recommend, make it explicit: "I'd default to X for reasons A and B. Are you OK with that, or do you want to override?" On an OK, search current docs and recent practice, write a brief reflecting present-day defaults verified against live docs rather than recycled training data, then return to step 2. Always ask, recommend, and guide; never silently decide.
4. Pick categories from [artifacts.md](artifacts.md) §4.
5. `piyaz_workspace action='create'` with the synthesis as `description` and the chosen `categories`.
6. Hand off to the decompose playbook or dispatch `piyaz:decompose`.

If the user is still vague after 2 focused questions, dispatch `piyaz:brainstorm`. They need the multi-turn experience.

## Decompose inline

For projects with a description of 300 words or fewer and 15 features or fewer.

1. Parse features, data entities, tech, scope boundaries, and user flows. Refuse if the description is too thin (under 100 words, or no features named) and escalate to brainstorm.
2. Plan: feature inventory, technical foundations, dependency sketch.
3. **Gate: present the plan as a markdown list of proposed tasks (title, status, a description preview) and edges (source, target, type, note); the descriptions written at create time meet the artifacts §1 bar, the edge notes name what crosses the boundary. Wait for explicit approval before any write.**
4. After approval:
   - `piyaz_workspace action='update' status='decomposing'` before the first write.
   - `piyaz_workspace action='update' categories=[...]` from [artifacts.md](artifacts.md) §4.
   - Create tasks and their internal edges in `piyaz_create` batches, `key`-addressed edges, at most 25 tasks per call. A retried batch dedupes by exact title, so a transport error mid-decompose is safe to re-run.
   - `piyaz_workspace action='update' status='active'`.
5. Validate: every feature has at least one task, no orphans, no cycles, and real parallelism rather than one long chain.
6. Summarize: total tasks, critical path, recommended starting tasks.

For projects over 300 words, over 15 features, or multi-domain, dispatch `piyaz:decompose`.

## Onboarding inline: don't

Onboarding from an existing codebase is never done inline. The fabrication risk on execution records is too high. Confirm with the user, then dispatch `piyaz:onboarding`, which has gated phases and programmatic verification.
