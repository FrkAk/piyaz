# Mymir mid-session resilience

How to survive long sessions: compaction, restart-from-scratch, and quality decay.

Agents read this file at session start (for resume mode) and after any compaction signal (memory gaps, fuzzy progress, "continue" / "resume" requests).

---

## 1. Why long sessions fail

Two failure modes, both lethal to Mymir's value:

1. **Compaction.** The conversation is summarized to fit context limits. The agent's memory of the plan, the decisions, and what it has already done gets reduced to whatever the summarizer keeps. When the agent wakes back up, it has less context than when it started.
2. **Quality decay.** As the session grows, agents get lazier. Task 5 has a 3-sentence description and 4 binary ACs; task 35 has a single sentence and "works correctly" as an AC. Token pressure compounds the laziness.

> **Worst-case outcome:** a decompose run restarts from scratch and creates BAT-1..12 again on top of the existing BAT-1..12. Polluted graph, no clear truth, lost user trust.

**The principle that prevents both:** treat Mymir state plus a local working file as the agent's memory, not the conversation.

---

## 2. Persist the plan to Mymir, not to the chat

After any approved gate (decompose Phase 1, onboarding Phase 3, brainstorm synthesis), append the approved plan to the project's `description` field.

- **Why.** The project description is durable across machines and survives session compaction. The chat does not.
- **Caveat.** `mymir_project action='update' description='...'` REPLACES the field; it does not append. Read-modify-write.
- **Effect.** The plan becomes recoverable on any session restart. `mymir_project action='select'` returns the description including your plan. Token-cheap retrieval.

**Read-modify-write procedure:**

1. Read the current description from the `select` response (already in your context).
2. Build the new value:
   ```
   <existing description>

   ---

   ## Decomposition Plan (approved <date>)

   <plan markdown>
   ```
3. `mymir_project action='update' description='<combined>'`.

---

## 3. Local working file (supplement to project description)

For high-write phases (decompose Phase 2, onboarding Phase 4), maintain a local working file alongside the project-description plan. Both should exist; they answer different questions.

| | Project description | Local working file |
|---|---|---|
| **Stored in** | Mymir server | `.mymir/<workflow>-<projectIdentifier>.md` |
| **Best at** | Authoritative cross-machine plan | Progress checklist, scratch notes, in-flight decisions |
| **Cost to write** | MCP roundtrip | Local I/O (free) |
| **Survives** | Any session, any machine | Compaction on the same machine |
| **Limit** | Stay concise; it is the user's project description | Richer; full discovery notes are welcome |

**Location:** `.mymir/<workflow>-<projectIdentifier>.md`. Examples:

- `.mymir/decompose-BAT2.md`
- `.mymir/onboarding-MYMR.md`

**Structure:**

```markdown
# Decompose working file: BAT2

projectId: 5ca57933-3c87-42ab-a28b-4780a2420f40
session: 2026-05-08
status: in-progress

## Plan (approved)

<full plan content from Phase 1, verbatim>

## Progress

- [x] BAT-1: Initialize Turborepo monorepo (created 2026-05-08)
- [x] BAT-2: Configure shared TypeScript tooling
- [ ] BAT-3: Define ClickHouse schema
- [ ] BAT-4: Define PostgreSQL schema
- ... (one line per task in the plan; check when created)

## Decisions in flight

- (decisions made or being considered, not yet persisted on a task)

## Notes / open questions

- (working notes, things to verify, ambiguities to resolve)
```

**Lifecycle:**

1. **Initialize**, immediately after the HARD-GATE clears and the plan is persisted to the project description.
   - `Bash`: `mkdir -p .mymir`
   - `Bash`: append `.mymir/` to `.gitignore` if not already present:
     ```
     grep -qxF '.mymir/' .gitignore 2>/dev/null || echo '.mymir/' >> .gitignore
     ```
   - `Write` the file using the structure above.
2. **Update** the progress checklist after every batch of task creates: every 5 to 10 tasks for decompose, 3 to 5 for onboarding. Update the notes section as new questions or in-flight decisions surface.
3. **Read first on resume**, when session-start runs resume mode or a compaction signal triggers mid-session.
   - Check the local file first via `Read`. If found, it has progress and notes; use it.
   - If missing, fall back to the project description (cross-machine scenario).
   - Either way, re-fetch `mymir_query type='list'` and dedupe.
4. **Cleanup or archive** when the workflow completes. Either:
   - Delete `.mymir/<workflow>-<projectIdentifier>.md`, or
   - Rename to `.mymir/archive/<workflow>-<projectIdentifier>-<date>.md` if the user wants a paper trail.

The `.mymir/` directory is scratch. Never committed. The first write should ensure `.gitignore` excludes it.

---

## 4. Resume mode (always run before any write phase)

At the start of any decompose / onboarding session, before any `mymir_task action='create'`:

1. **Check the local working file first.** `Read` `.mymir/<workflow>-<projectIdentifier>.md`. If it exists, that is your working state.
2. If the local file is missing, `mymir_query type='list'` (slim) plus re-read the project description from the `select` response. If a Decomposition Plan or Onboarding Proposal section exists in the description, that is your authoritative plan.
3. Compare: which planned tasks already exist (match by title), which are missing.
4. **If existing tasks > 0:** you are resuming. Surface this to the user: "I see N tasks already exist in this project. The approved plan calls for M tasks. I'll create the M-N missing ones." Do NOT recreate existing tasks.
5. **If existing tasks == 0:** fresh run. Proceed normally.
6. **If existing tasks do not match the approved plan** (different titles, manually-created tasks, etc): surface the conflict. Ask the user how to proceed. Do not silently overwrite.

---

## 5. Idempotent task creation

**Build a known-titles set once at the start of the write phase, then dedupe in memory.**

```
existing = { task.title.lower() for task in mymir_query_list_result }
for planned_task in plan:
    if planned_task.title.lower() in existing:
        skip; continue
    create planned_task
    existing.add(planned_task.title.lower())
```

- One slim `list` call (single MCP roundtrip).
- Dedupe runs in-memory (free).
- Cheaper than per-task search-before-create.

---

## 6. Quality checkpoints

Self-audit on a cadence. Defaults:

- **Decompose:** after every 10 task creates.
- **Onboarding:** after every 5 done-task creates (the higher-stakes write).
- **Manage:** after every 5 structural changes (status transitions, edge edits) in a single session.

The audit:

1. Re-read `references/artifacts.md` §1 (artifact quality).
2. Pick the last 3 tasks you created. For each, score:
   - Description: 2 to 4 sentences? If single-sentence, REWRITE.
   - ACs: 2 to 4 binary criteria? If single or vague, REWRITE.
   - Tags: all four dimensions present? If any missing, FIX.
   - Category: matches a project category, not a forbidden one? If wrong, FIX.
3. If any of those need fixing, run `mymir_task action='update'` BEFORE creating more.

Quality drift compounds. A bad task at position 15 is a 5-second fix. The same drift discovered at position 50 means rewriting 35 tasks.

---

## 7. Compaction signals (when to STOP and resume)

If you sense any of these, STOP creating tasks and run resume mode:

- You can not account for tasks you remember the plan calling for.
- You see existing tasks in the project but do not remember creating them.
- You are uncertain whether you have completed Phase 2 / 3 / 4.
- Decisions you remember making no longer appear in your context.
- The user said "continue where you left off" or "resume".
- The conversation has been long and your sense of progress is fuzzy.

Do not power through. The user invoked you to produce quality work, not to restart their project from scratch on top of a partial graph.

---

## 8. What this means in practice

- Plan is durable: it lives in the project description (cross-machine) and the local working file (in-session).
- Progress is durable: progress checklist in the local working file; derivable from `mymir_query type='list'` if the local file is missing.
- Quality is enforced: periodic self-audit catches drift.
- Recovery is automatic: resume mode runs at every session start, reads local file first, falls back to project description.

The conversation can compact, the session can crash, the agent can lose track. Mymir state plus the local working file are the source of truth. Read from them, write to them, and trust them over your own memory.
