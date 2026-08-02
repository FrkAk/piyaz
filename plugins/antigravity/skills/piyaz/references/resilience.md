# Piyaz mid-session resilience

How to survive long sessions: compaction, restart-from-scratch, and quality decay. Read at session start in resume mode, and after any compaction signal (memory gaps, fuzzy progress, a "continue" or "resume" request).

## Contents

- §1 Why long sessions fail
- §2 Persist the plan to Piyaz, not to the chat
- §3 Local working file (`.piyaz/`)
- §4 Resume mode (run before any write phase)
- §5 Idempotent batch creation
- §6 Quality checkpoints
- §7 Compaction signals (when to stop and resume)
- §9 Server vs agent-enforced rules
- §10 Transport and auth errors are not retryable in-session
- §11 Headless and non-interactive runs

---

## 1. Why long sessions fail

Two failure modes, both lethal to Piyaz's value:

1. **Compaction.** The conversation is summarized to fit context limits, and the agent's memory of the plan, the decisions, and what it has already done shrinks to whatever the summarizer kept. It wakes back up with less context than it started with.
2. **Quality decay.** As the session grows, agents get lazier. Task 5 has a grounded description and binary criteria; task 35 has a single sentence and "works correctly". Token pressure compounds it.

The worst case is concrete: a decompose run restarts from scratch and creates LUM-1..12 again on top of the existing LUM-1..12. Polluted graph, no clear truth, lost trust.

The principle that prevents both: treat Piyaz state plus a local working file as your memory, not the conversation.

---

## 2. Persist the plan to Piyaz, not to the chat

After any approved gate (decompose Phase 1, onboarding Phase 3, brainstorm synthesis), append the approved plan to the project's `description`.

The project description is durable across machines and survives compaction; the chat does not. The plan becomes recoverable on any restart through `piyaz_get project='<identifier>' view='meta'`, which is a cheap read.

`piyaz_workspace action='update' description='...'` replaces the field rather than appending, so read-modify-write:

1. Read the current description via `view='meta'`, or reuse it if it is already in context.
2. Build the new value:
   ```
   <existing description>

   ---

   ## Decomposition Plan (approved <date>)

   <plan markdown>
   ```
3. `piyaz_workspace action='update' project='<identifier>' description='<combined>'`.

---

## 3. Local working file

For high-write phases (decompose Phase 2, onboarding Phase 4), keep a local working file alongside the project-description plan. Both should exist; they answer different questions.

| | Project description | Local working file |
|---|---|---|
| **Stored in** | Piyaz server | `.piyaz/<workflow>-<projectIdentifier>.md` |
| **Best at** | Authoritative cross-machine plan | Progress checklist, scratch notes, in-flight decisions |
| **Cost to write** | MCP roundtrip | Local I/O (free) |
| **Survives** | Any session, any machine | Compaction on the same machine |
| **Limit** | Stay concise; it is the user's project description | Richer; full discovery notes welcome |

Location: `.piyaz/<workflow>-<projectIdentifier>.md`, for example `.piyaz/decompose-LUM.md` or `.piyaz/onboarding-KRN.md`.

Structure:

```markdown
# Decompose working file: LUM

projectId: 0b6e4a2d-9c1f-4e83-8a57-3d2f5b7c9e14
session: 2026-05-08
status: in-progress

## Plan (approved)

<full plan content from Phase 1, verbatim>

## Progress

- [x] LUM-1: Initialize Turborepo monorepo (created 2026-05-08)
- [ ] LUM-3: Define ClickHouse schema
- ... (one line per task in the plan; check when created)

## Decisions in flight

- (decisions made or being considered, not yet persisted on a task)

## Notes / open questions

- (working notes, things to verify, ambiguities to resolve)
```

Lifecycle:

1. **Initialize** right after the gate clears and the plan is persisted to the project description. `mkdir -p .piyaz`, append `.piyaz/` to `.gitignore` if absent (`grep -qxF '.piyaz/' .gitignore 2>/dev/null || echo '.piyaz/' >> .gitignore`), then write the file.
2. **Update** the checklist after every batch of creates: every 5 to 10 tasks for decompose, 3 to 5 for onboarding.
3. **Read first on resume.** Check the local file; if missing, fall back to the project description for the cross-machine case. Either way `piyaz_activity since='<last certain instant>'` shows what was created while your memory is fuzzy, and the batch creator dedupes by title regardless.
4. **Clean up or archive** on completion: delete it, or rename to `.piyaz/archive/<workflow>-<projectIdentifier>-<date>.md` if the user wants a paper trail.

`.piyaz/` is scratch and never committed.

---

## 4. Resume mode (always run before any write phase)

At the start of any decompose or onboarding session, before any `piyaz_create`:

1. **Check the local working file first.** Read `.piyaz/<workflow>-<projectIdentifier>.md`. If it exists, that is your working state.
2. If it is missing, `piyaz_activity project='<identifier>' since='<last certain instant>'` shows everything created or changed while you were away, and `piyaz_get project='<identifier>' view='meta'` re-reads the description. A Decomposition Plan or Onboarding Proposal section in the description is your authoritative plan.
3. Compare: which planned tasks already exist (the activity feed's `task_created` events name them by ref, and `piyaz_search project='<identifier>' status=[...]` fills gaps), and which are missing.
4. **If existing tasks > 0**, you are resuming. Surface it: "I see N tasks already exist in this project. The approved plan calls for M tasks. I'll create the M-N missing ones." Re-running the batch is safe, since `piyaz_create` dedupes by exact title and returns matches as `deduped`.
5. **If existing tasks == 0**, it is a fresh run. Proceed normally.
6. **If existing tasks do not match the approved plan** (different titles, manually created tasks), surface the conflict and ask how to proceed. Do not silently overwrite.

---

## 5. Idempotent batch creation

The server dedupes for you. `piyaz_create` skips items whose exact title already exists in the project and returns them as `deduped`, still usable as edge endpoints in the same call. A restarted decompose can re-send the same batch payload verbatim:

- Same payload, second run: `created: []`, `deduped: [every task]`, existing edges silently skipped. A clean no-op.
- Partial first run: the re-run creates only the missing tail.
- `onDuplicate='error'` flips to reject-the-whole-batch, for when duplication would signal a planning bug rather than a resume.

Keep batches at 25 tasks or fewer with their internal `key`-addressed edges in the same call, and chunk larger plans into consecutive batches. Read the `deduped` hint on every response so your working-file checklist stays truthful.

---

## 6. Quality checkpoints

Self-audit on a cadence: after every 10 task creates for decompose, every 5 done-task creates for onboarding (the higher-stakes write), and every 5 structural changes for manage.

Pick the last 3 tasks you created and score each: description covering what §1 asks of its task type (rewrite single-sentence ones), criteria each one binary check (rewrite single or vague ones), all three tag dimensions present (priority lives in the `priority` field, not in tags), and a category from the project's list. Fix anything failing with a surgical `piyaz_edit` before creating more. The bar is [artifacts.md](artifacts.md) §1.

Quality drift compounds. A bad task at position 15 is a 5-second fix; the same drift found at position 50 means rewriting 35 tasks.

---

## 7. Compaction signals (when to stop and resume)

Stop creating tasks and run resume mode if you notice any of these:

- You cannot account for tasks you remember the plan calling for.
- You see existing tasks in the project but do not remember creating them.
- You are unsure whether you completed Phase 2, 3, or 4.
- Decisions you remember making no longer appear in your context.
- The user said "continue where you left off" or "resume".
- The conversation has run long and your sense of progress is fuzzy.

Do not power through. The user invoked you to produce quality work, not to restart their project on top of a partial graph.

---

## 9. Server vs agent-enforced rules

Some conventions are validated by the server; others depend on agent discipline. Knowing which is which stops you assuming a safety net that is not there.

**Server-enforced**, meaning it rejects or warns: cycles (with the chain named), self-edges, duplicate edges ("treat as success"; silently skipped inside a `piyaz_create` batch), batch title duplication (deduped by exact title, or rejected under `onDuplicate='error'`), stale writes (`ifUpdatedAt` mismatch, returning the fresh `updatedAt`), `str_replace` precision (0 or 2+ matches, with the occurrence count), cancellation transparency (dependents stay blocked through cancelled deps' own unsatisfied prerequisites), identifier uniqueness per team, identifier rename cascading all task refs, and delete preview-by-default with `_hints` instructing the second call.

**Agent-enforced**, with no safety net:

- Tag taxonomy: kebab-case, all three dimensions present, no codebase-area tags, no priority strings.
- Description quality: covers its task type's recipe, never a single sentence.
- Acceptance criteria: each one binary check, no "works correctly" filler.
- Edge notes: substantive, never "needed" or "depends".
- Lifecycle monotonicity. The server hints on jumps but does not block them.
- `view='overview'` at most once per session. Skill discipline only.
- Destructive ops: `set` on a text field replaces it wholesale and `remove` deletes the item, with no warning and no undo. The activity log records that a change happened, not the prior content. Prefer `str_replace`, `append`, and by-id ops, and confirm wholesale rewrites with the user.

When in doubt, treat any rule in [artifacts.md](artifacts.md), [specs/contracts.md](specs/contracts.md), or [lifecycle.md](lifecycle.md) as agent-enforced unless this section says otherwise.

---

## 10. Transport and auth errors are not retryable in-session

If a Piyaz tool call returns `requires re-authorization`, `token expired`, a 401 or 403 from the MCP transport, a 5xx, or a network error (connection refused, timeout, DNS failure), stop and surface it.

These mean the host's authentication or the connection itself is broken, and the agent cannot self-heal: the user or the host UI has to re-authenticate or re-establish the connection.

1. Stop. Do not retry the same call, and do not proceed to the next step assuming the prior write succeeded.
2. Do not fabricate the artifacts that would have followed a successful call. The Iron Law applies: you cannot cite what you do not have.
3. Surface the failure with the exact error text and the last completed step: "Piyaz auth expired after creating LUM-12. Re-authenticate and I will resume from LUM-13."
4. Wait for confirmation that the connection is restored before resuming.

A session that silently retries a 401 in a loop wastes tokens and produces nothing. One that fabricates the rest of the workflow produces actively misleading state.

---

## 11. Headless and non-interactive runs

The ask_user tool requires a user attached to the session. Codex `exec`, the Claude Agent SDK without a `canUseTool` callback, policy-deny contexts, and CI environments all reject or hang on the call. When you detect headless mode (the tool errors with "no input available", "policy denied", or equivalent), do not loop and do not silently fabricate a default:

1. Pick the safest, most reversible default for the decision at hand.
2. Record both the question you would have asked and the default you chose in the task's `executionRecord`, or in the local working file if you are pre-task.
3. Surface the assumption in the next interactive turn so the user can override it.

Headless mode is not a license to skip pushback. If a decision genuinely cannot be defaulted (auth provider, deployment target, primary data store), stop and emit a structured error rather than guessing.
