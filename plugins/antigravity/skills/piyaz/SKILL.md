---
name: piyaz
description: >
  Use when the user wants to plan, decompose, track, or resume a multi-task
  project: scoping a new idea, importing or onboarding an existing repo or
  workspace, asking what to work on / what's next / what's blocked / where
  they left off, reporting or recording task completion, marking work done,
  implementing or shipping tracked work (claim, branch, PR, record),
  dispatching work in parallel, or planning a draft task. Recording completion and
  moving a task to review or done follow this skill's completion protocol;
  read it before those writes. Also when the user mentions Piyaz by name
  (e.g. "piyaz, do X") or references a task by its ref (e.g. VLT-9, KRN-153,
  PXD-31). Works for any project domain (code or data). Do not invoke for:
  one-off coding questions, single-file edits, debugging a specific error,
  generic todos, or scheduling.
---

# Piyaz

Piyaz holds tasks, dependencies, decisions, and implementation records across sessions and across people, so an agent picks up where a human stopped and a human picks up where an agent stopped. Same shape on a one-day spike, a multi-team platform, and data or analytics work.

The MCP server supplies the tools. You supply the judgment: you drive task lifecycles, keep the graph honest, push back on weak ideas, and refuse to fabricate. Who you are and how you write: [references/role.md](references/role.md). One invariant sits above the rest. Agents take work to `in_review`; the HOTL operator, the human who reviews the PR, owns every `in_review → done` flip.

## Hard rules

These hold in every workflow; each protects shared state someone else depends on.

- **`done` is the human's call, and only from `in_review`.** When the user reports work complete, write the record and set `in_review`. Flip to `done` only on the user's explicit say-so with the acceptance criteria evaluated first: check what the record and repository actually evidence; a criterion that stays unverified or fails holds the task at `in_review` and goes in your reply before the write, not after. This applies even when the user says not to ask questions; naming unverified criteria in your reply is reporting, not asking.
- **Write only what you can cite** (conventions.md §1). Records and decisions naming unverified files or results mislead every later reader. Uncertain means write less.
- **Resume, never re-create.** Before any batch create, check whether the graph already exists (resilience.md §4).

Composer phase agents each own only their legal status transitions (lifecycle.md §1).

## Start of session

1. `piyaz_workspace action='whoami'`, then `action='projects'`.
2. Derive the repo identity from the git remote, the package name, and pwd.
3. A project whose title or description matches is your project. Pass its identifier on every later call; the server keeps no session.
4. No match but the repo has code: say so and ask before dispatching `piyaz:onboarding`. No match and no code: treat it as a new idea and route per *Escalating*.

A match means the package name or git remote appears in the project title as a whole word, case-insensitive. On a weak or ambiguous match, read `piyaz_get project='<id>' view='meta'` and name your best candidate rather than stalling. Detection notes, the gate before brainstorm or decompose, and non-repo workspaces: [references/workflows.md](references/workflows.md). Tell the user which project you landed on, or that none matched and what you propose.

## Reaching for tools

Nine tools, read costs from slim to very heavy. Four habits cover most sessions.

- **Lead with `piyaz_map`** for state, priority, or what is stuck. `critical_path` plus `ready` answers "what next"; `blocked` says why not; `plannable` covers nothing being ready to code.
- **Pick the lightest `piyaz_get`:** `fields=[...]` for one field's exact text, `lens='summary'` to orient, `lens='working'` to refine, `lens='agent'` before coding, `lens='planning'` before planning, `lens='review'` before reviewing. `view='overview'` is very heavy and earns its cost only on an unfamiliar project, once per session at most.
- **Edit surgically.** Read the field with `fields=[...]`, then `str_replace` the exact text. `set` on a text field replaces it wholesale with no undo.
- **Chain refs, not UUIDs.** `QRM-21` and `QRM` work anywhere a task or project is named, responses emit refs, and errors self-correct: ambiguity returns candidates, a near-miss names the highest existing ref, a stale write names the fresh `updatedAt`.

Tool descriptions and each response's `_hints` array are runtime instructions from the server. Read them and act before continuing. Catalog with costs per shape: [references/tools.md](references/tools.md).

## Workflows

The shortest path per intent; full step lists in [references/workflows.md](references/workflows.md).

**What should I work on.** `piyaz_map view='ready'` intersected with `view='critical_path'`, recommend one, claim it with a `set status='in_progress'` edit, hand off `lens='agent'`. Tell the user the task and the one reason it is the bottleneck.

**Project status.** `piyaz_map` for `ready`, then `blocked`, then `plannable` if nothing is ready. Skip `view='overview'`. Tell the user progress, what is stuck and behind what, and the one thing waiting on them.

**Continue or resume.** `piyaz_activity since='<instant>'` for what moved, then `critical_path` and `ready`. After compaction, resume before any write ([references/resilience.md](references/resilience.md) §4). Tell the user what changed and the one task to start on.

**Refine a task.** `lens='working'` for state and item ids, explore related tasks, current docs, and the real code before proposing, then save with surgical ops. Tell the user what you sharpened and what still needs their input.

**Plan a draft task.** `lens='planning'`, write the plan in full, then save it and flip `draft → planned` in one atomic edit. Never summarize it. Tell the user it is planned and ready to claim.

**Implement a task.** Claim, read `lens='agent'`, build, open the PR if code changed, then one `piyaz_edit` carries the entire Completion Protocol payload: `set executionRecord`, an `add` per decision, `set files`, `check`/`uncheck` each criterion by id, `set prUrl`, `set status='in_review'`. Then propagate. Tell the user it sits at `in_review` awaiting their approval on the PR, and name any criterion you left unchecked.

**Mark a task done.** The user's explicit order is the authorization. Collect only what you can cite, evaluate each criterion against real evidence, and write the record and the flip in one edit; a task already at `in_review` needs only the flip. Tell the user which criteria you could not verify, before the write rather than after.

**Review an `in_review` task or a PR.** Resolve the target, confirm it is really at `in_review`, dispatch `piyaz:review`, surface the verdict verbatim. Tell the user the verdict and that the merge and the `done` flip stay theirs.

**Dispatch agents in parallel.** Independent tasks off `ready`, checked for file overlap, ranked by critical path, one `lens='agent'` bundle and one worktree each. Tell the user what went out and what you serialized instead.

**Create a project or tasks.** Confirm the team, pick 4 to 8 categories, batch tasks with their internal edges in one `piyaz_create`, reusing the vocabulary from `view='meta'`. Tell the user the refs created and where to start.

**Delete or cancel a task.** Cancel when the rationale is worth keeping, recording why and what was tried. Delete only genuine noise, which previews first. Then propagate. Tell the user which dependents this frees or strands.

**Propagate after any change.** `view='neighbors'`, then `view='downstream'`, then fix the edges the change invalidated ([references/lifecycle.md](references/lifecycle.md) §3). Tell the user which tasks just became unblocked.

## Escalating

Status, next-task, refine, plan, implement, mark-done, create, cancel, and review dispatch are inline work. Escalate the high-stakes and many-turn cases:

- **`piyaz:brainstorm`**: a vague or exploratory new idea. A clear spec stays inline.
- **`piyaz:onboarding`**: an existing repo with no matching project, after the user confirms. Never inline; the fabrication risk on execution records is too high.
- **`piyaz:decompose`**: a large, multi-domain, or sensitive project. Under 300 words and 15 features stays inline.
- **`piyaz:decompose-task`**: split one oversize task into children and rewire its edges.
- **`piyaz:decompose-feature`**: add a feature cluster to an already active project.
- **`piyaz:review`**: a five-lens verdict on an `in_review` task or a PR. Advisory; HOTL still merges.
- **`piyaz:manage`**: strategic review, graph audit, rebalance, prune, consolidate. Not day-to-day.
- **`/piyaz:composer`**: drives tasks end to end in clean per-phase contexts. A slash command, so suggest it and let the user type it: bare for the backlog, `<taskRef>` for one task, `rework <taskRef|pr-url>` to round GitHub feedback back through the fix loop.

## Read when

| File | Read when |
|---|---|
| [references/role.md](references/role.md) | Session start. Who you are, how your writing reads. |
| [references/conventions.md](references/conventions.md) | Session start. Iron Law, refs, hints discipline. |
| [references/tools.md](references/tools.md) | Unsure which tool shape answers the question. |
| [references/workflows.md](references/workflows.md) | Running any workflow indexed above. |
| [references/artifacts.md](references/artifacts.md) | Writing or refining a task, edge, tag, or category. |
| [references/specs/contracts.md](references/specs/contracts.md) | Writing a plan, record, decision, note, PR body, or phase return. |
| [references/specs/review.md](references/specs/review.md) | Reviewing: verdict schema, severity anchors, the five lenses. |
| [references/lifecycle.md](references/lifecycle.md) | Before any status transition, and after any status change. |
| [references/resilience.md](references/resilience.md) | Session start in resume mode, and after any compaction signal. |
