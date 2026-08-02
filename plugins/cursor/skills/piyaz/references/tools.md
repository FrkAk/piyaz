# Piyaz tool catalog

Every tool shape, its cost, and the question it answers. Read this when you are unsure which shape to reach for; the router in `SKILL.md` carries the four habits that cover most sessions.

Read tools run slim to very heavy. Pick the lightest shape that answers the question. Mutation tools have side effects; the destructive ones are flagged below.

## What the server already tells you

The server's own instructions cover multi-team awareness (404-shaped probes for unowned ids, `organizationId` required on writes when the account spans several teams), the session-start sequence, and the canonical flows for finding work, implementing a task, and planning a draft. Tool descriptions and each response's `_hints` are runtime instructions, not commentary: read them on every call and act before continuing.

Refs are first-class. Every tool takes a taskRef (`QRM-21`) or project identifier (`QRM`) anywhere a task or project is named, with UUIDs as fallback, and responses emit refs, so you never carry a UUID between calls. Errors self-correct: ambiguity returns candidates, a near-miss names the highest existing ref, a failed `str_replace` names the occurrence count, a stale write names the fresh `updatedAt`.

There is no `select` and no server-side session. Pass the project identifier, or a taskRef implying it, on every call.

## `piyaz_workspace`: identity, teams, projects

| Action | Cost | Use when |
|---|---|---|
| `whoami` | slim | session start. User id, name, team count. |
| `projects` | slim | session start. Title, identifier, description, counts, team, for every team you belong to. Skips empty teams. |
| `teams` | slim | before creating a project on a multi-team account, when `projects` is empty, or when the user names a team it did not surface. Includes empty teams. |
| `members` | slim | before assigning work. One team's directory, and the UUID source for `assigneeIds` and `assignee='<uuid>'` filters. `organizationId` picks the team; single-team accounts auto-resolve. |
| `create` | mutation | new project after the brainstorm gate clears, or on explicit request. Multi-team accounts require `organizationId`. |
| `update` | mutation | rename, add categories, or move status. `archived` makes the task surface read-only; unarchive with `status='active'`. Changing the identifier renames every taskRef and breaks external links. `categories=[...]` replaces the vocabulary without touching task rows, so use it for additions and reorders only. |
| `rename_category` | mutation | rename an entry and move every task in it, atomically. Renaming via `update categories=[...]` orphans the tasks instead. |
| `delete_category` | mutation | remove an entry; its tasks become uncategorized. Re-categorize them afterwards. |

## `piyaz_search`: find tasks anywhere

| Shape | Cost | Use when |
|---|---|---|
| `query='...'` | slim | find tasks by taskRef, title substring, or tag substring. Cross-project across every team by default. |
| filters | slim | `status=[...]`, `priority=[...]`, `assignee='me'`, `category='...'`, `tags=[...]` (AND-within). Combine freely; at least one criterion is required. |
| `project='QRM'` | slim | scope to one project. Scoped results carry the derived state (`ready` / `blocked` / `plannable` / ...). |

Results come back newest-updated first with a cursor when more pages exist. Narrow the filters rather than paging. A single-result response carries a state hint pointing at the right next call; follow it.

## `piyaz_get`: read one task or one project

| Shape | Cost | Use when |
|---|---|---|
| `fields=['...']` | slim | the cheapest read: exactly the named fields' raw values, plus `updatedAt` (for `ifUpdatedAt`) and collection item ids (for by-id edits). This is the read before every surgical edit. Fetch `fields=['implementationPlan']` before a `str_replace`, `fields=['acceptanceCriteria']` before checking items. |
| `lens='summary'` | slim | quick status check on one task: status, description, edge counts, 1-hop edges with notes. |
| `lens='working'` | medium | refining, discussing, or reviewing a task. Criteria, decisions, and links with their ids (the edit addresses), plus 1-hop edges. |
| `lens='agent'` | heavy | handing off to a coding agent. Implementation plan, multi-hop upstream execution records each with its PR link, work-so-far, related non-blocking tasks, "Done Means", downstream specs. Roughly 4-8K tokens. Carries a blocked section when direct prerequisites are unfinished, and returns the retrospective instead for `done` / `cancelled` tasks. No bundle renders file lists; the linked PR diff is the source of truth for what changed. |
| `lens='planning'` | heavy | writing an implementation plan. Project description, criteria, upstream execution records, work-so-far, downstream specs, task links, and abandoned approaches (cancelled-dep records with their closed-PR links). |
| `lens='review'` | heavy | reviewing an `in_review` task. Renders `implementationPlan` alongside `executionRecord`, surfaces the PR link, lists downstream impact, emits review-lens prompts. The PR diff is the source of truth. Read by `piyaz:review` in composer Phase 4 and direct review dispatch. |
| `lens='record'` | medium | the retrospective for a `done` / `cancelled` task: outcome, decisions, PR link, cancellation rationale. |
| `project='QRM' view='meta'` | slim | categories, tag vocabulary with usage counts, description, status, progress. Read before setting a `category`, before coining tags, or for a quick read of where the project stands. |
| `project='QRM' view='overview'` | very heavy | full structure, budgeted: tasks grouped by status (over-limit groups truncate and name the `piyaz_search` filter for the rest), every edge. Reserve for initial exploration of an unfamiliar project, the manage agent's strategic review, and decompose's pre-write coverage check. Not for routine status questions, once per session at most. For categories or tag vocabulary use `view='meta'`. |

## `piyaz_create`: batch task creation

One call creates 1-25 tasks plus the edges wiring them, atomically. Give each task a `key`; edge `source`/`target` accept keys, taskRefs, or UUIDs. Required per task: title, description, and ideally criteria, category, three tag dimensions, and priority. Quality bar: [artifacts.md](artifacts.md) §1-§4.

Idempotent by exact title: a re-run skips existing titles and returns them as `deduped`, still usable as edge endpoints, so a restarted decompose never duplicates a task set. `onDuplicate='error'` rejects the whole batch instead. Identical existing edges are silently skipped.

## `piyaz_edit`: operation-based task editing

One call applies 1-20 ordered operations to one task, atomically; one failure rolls back all of them.

| Op | Target | Use when |
|---|---|---|
| `str_replace` | `description` / `implementationPlan` / `executionRecord` | surgical text edit. `oldStr` must match exactly once, so copy the exact text from `piyaz_get fields=[...]` first. The error names the occurrence count. |
| `append` | text fields | add a paragraph (progress notes, addenda) without touching existing text. |
| `set` | text fields and scalars (`status`, `priority`, `estimate`, `category`, `title`, `tags`, `files`, `prUrl`) | full replace. For text fields prefer `str_replace` or `append`; `set` on a text field is destructive. |
| `add` | `acceptanceCriteria` / `decisions` / `links` / `assignees` | append one item (`text`, `url`, or `value='me'` / user UUID). |
| `update` / `check` / `uncheck` / `remove` | collections, by item `id` | targeted item edits. Ids come from `lens='working'` or `fields=[...]`. `remove` is destructive with no undo. |
| `delete_task` | the task | must be the only op. Previews by default; `preview=false` executes. Prefer cancelling (see [workflows.md](workflows.md)). |

`ifUpdatedAt`, taken from a prior read, turns the whole call into a compare-and-swap for contended tasks: a stale write fails with the fresh `updatedAt`, so re-read and retry. Status transitions return lifecycle hints; act on them.

## `piyaz_link`: dependencies and relationships

| Action | Cost | Use when |
|---|---|---|
| `create` | mutation | wire `depends_on` (source needs target's output) or `relates_to` (informational link). `source` / `target` take refs. An edge note is required and must brief the source-task developer. Note quality: [artifacts.md](artifacts.md) §3. |
| `update` | mutation | rewrite the note, keyed by `source` + `target` + `type` (`type` is the lookup key there). To change a type, `remove` then `create` with a fresh note, or pass `edgeId` from the create response plus the new `type`. |
| `remove` | mutation | drop a stale edge surfaced by propagation; same keys. |

A "duplicate edge" response means the edge already exists. Treat it as success.

## `piyaz_map`: navigate the graph

| View | Cost | Use when |
|---|---|---|
| `ready` | slim | tasks with every dependency done. The lead view for "what should I work on"; pick from here first. |
| `blocked` | slim | tasks waiting on unfinished dependencies, with blocker details. Diagnose what is stuck. |
| `plannable` | slim | draft tasks that have a description and criteria and are ready for planning. Use when nothing is `ready` to code. |
| `critical_path` | slim | the longest dependency chain, which is the project bottleneck. The most important view for prioritization: tasks on the chain set the minimum project duration. Lead with it on continue, resume, and "guide me forward". |
| `downstream` | slim | transitive dependents of one task. Impact analysis before a status change, a refinement, or a cancellation. |
| `neighbors` | slim | 1-2 hops around one task, both edge types, both directions, with notes. The context-network walk: see what a task touches, then chain any ref into `piyaz_get`. |

## `piyaz_activity`: what changed

A keyset-paginated event feed per project, task, or note, newest first. `since='<ISO instant>'` answers "what changed while I was away", the resume primitive ([resilience.md](resilience.md) §7). Events carry actor, type, summary, and target ref; follow up with `piyaz_get`. `note_*` events ride the same feed, so resume covers notes too.

`note='WQN-N8'` scopes to one note's history of edits, moves, links, and restores, and requires the note to be agent-exposed (team visibility, feed enabled). A non-exposed note reads as not found, and project and task feeds silently exclude its events.

## `piyaz_note`: the project knowledge base

Notes live in the same folder tree humans see in the web UI and are ref-first (`TRV-N3`; a slug works with `project`). Three types with distinct delivery: `guidance` is a short constraints block auto-injected into matching task bundles, `reference` holds specs and docs read on demand by heading, `knowledge` is the agent-maintained wiki and memory. When a note feeds a task through `feedMode`, `guidance` injects its full body while the other two inject a title-plus-summary pointer read on demand.

Write back what you learn: a gotcha you hit, a convention you settled, work the next agent builds on. Note body shape: [specs/contracts.md](specs/contracts.md).

| Action | Cost | Use when |
|---|---|---|
| `create` | mutation | 1-10 notes per call, idempotent by exact (folder, title). Agent-created notes land at `visibility=team, feed_mode=none`: teammates' agents can search them immediately, but nothing auto-injects until `feedMode` is set deliberately (`all` / `categories` / `tags` / `tasks`; `feedTaskIds` accept taskRefs). Check `list` first and reuse existing folders. Always set `summary`; it rides every tree list, search hit, and feed pointer. |
| `read` | slim to heavy | meta header by default (sections, links, the `ifUpdatedAt` token). `fields=[...]` for exact values, `heading='...'` for one section (the cheap body read), `fields=['revisions']` for the snapshot list, `revision=N` for one snapshot. `fields=['body']` is heavy; prefer heading reads. |
| `edit` | mutation | 1-20 ordered ops, atomic, `piyaz_edit` semantics: `str_replace` / `append` / `set` on `body` (oldStr must match exactly once), `set` for title, summary, folder, type, category, tags, feed fields. `ifUpdatedAt` makes it a compare-and-swap. `visibility`, `locked`, `agent_writable` are not editable here. |
| `list` | slim | the folder tree with refs, types, and governance flags. Run before creating or moving notes so the tree stays organized for humans. |
| `move` | mutation | `note` + `folder` moves one note; `folder` + `destParent` (+ `newLeaf`) re-parents or renames a folder subtree. |
| `delete` / `restore` | mutation | delete previews by default (re-call with `preview=false`); restore recovers a trashed note by UUID, since a trashed ref no longer resolves. An overwritten body recovers via `revision=N` then `set body`. |
| `request_share` | mutation | ask a human to make a private note team-visible. The only way an agent influences visibility. |
| `link` / `unlink` | mutation | deliberate note-task relations, kind `reference` or `spec_of` (this note is the task's spec). Any team-visible backlink surfaces under Relevant Notes as a title-plus-summary pointer at lens `agent` or `planning`, independent of `feedMode`. `mention` rows derive from body refs (`[[JYG-14]]`, `[[Note Title]]`), not this action; write the ref into the body. |
| `search` | heavy | a full noteRef (`TRV-N3`, case-insensitive) resolves directly, falling back to full text when it resolves nothing. Every other query is ranked full text in one project: team notes plus your own private notes, regardless of feed mode. Chain a hit into `read heading='...'`. |

## Picking a shape

1. Status, prioritization, "what's next", "what's stuck": start with `piyaz_map`. Every view is slim.
2. Finding a specific task: `piyaz_search` with a title fragment, a tag, or filters.
3. After identifying a task: `piyaz_get` at the right lens, letting `_hints` steer you, or `fields=[...]` when you need one field's exact text.
4. `piyaz_get view='overview'` only when nothing lighter gives you the picture you need.
5. Mutations (`piyaz_workspace`, `piyaz_create`, `piyaz_edit`, `piyaz_link`, `piyaz_note`): surgical ops, then read the response `_hints` and re-call for anything missing.
6. Durable knowledge (constraints, conventions, learnings, specs): `piyaz_note`. Search notes before re-deriving something a teammate's agent may already have recorded, and write one after discovering something the next agent needs.
