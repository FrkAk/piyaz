# Piyaz conventions

The always-rules: grounding, `_hints` discipline, ref format, and how to ask. Read this once at session start.

The MCP server documents tool actions, multi-team awareness, session flow, and the core workflows. These files cover what the server does not know: artifact quality, taxonomy, role, gates, and discipline. They apply to every kind of project Piyaz runs on, which is all of them: web and SaaS, mobile, games and engines, simulation and scientific code, embedded firmware, hardware and aerospace, ML pipelines, financial models, security tooling, agentic systems, libraries and SDKs and CLIs, hackathon throwaways, and data and analytics work. Examples across these files are deliberately drawn from many domains.

Every Piyaz skill and agent follows these rules. Drift between any rule file and any agent is a bug.

## How this is split

| File | Read when | Covers |
|---|---|---|
| [role.md](role.md) | Session start. | Who you are, how the text you write reads. |
| [tools.md](tools.md) | Unsure which tool shape answers the question. | All nine tools, cost per shape, selection heuristic. |
| [workflows.md](workflows.md) | Running a workflow the router indexes. | Full step lists: detection, status, refine, plan, implement, mark done, review, parallel dispatch, create, cancel, inline playbooks. |
| [artifacts.md](artifacts.md) | About to write or refine any task or edge. | Title, description, acceptance criteria, files (§1). Tag dimensions and first-class fields (§2). Edge types (§3). Categories (§4). Granularity (§5). |
| [specs/contracts.md](specs/contracts.md) | Writing a plan, record, decision, note, PR body, or phase return. | The written shape of every long-form artifact. |
| [lifecycle.md](lifecycle.md) | Before any status transition; after any status change. | Status lifecycle (§1). Completion Protocol (§2). Propagation Iron Law (§3). |
| [resilience.md](resilience.md) | Session start in resume mode; after any compaction signal. | Long-session survival: resume, idempotent creation, quality checkpoints, transport errors, headless runs. |

References renumber from §1 within their own file. When this document or an agent says "artifacts §4", it means section 4 of `artifacts.md` (categories), not section 4 of this file.

---

## 1. The Iron Law of grounding

```
Never write what you cannot cite or do not know.
```

It applies wherever an agent generates `executionRecord`, `decisions`, `description`, or `files`.

- `executionRecord` claims reference real code: file paths that exist, functions that are defined, endpoints that are routed, commits in the log. The onboarding agent verifies file existence with Bash before claiming.
- `description` reflects actual scope. A one-line ask does not become an invented full feature.
- `files` lists paths the agent modified, observed, or has explicit confirmation exist.

When uncertain, write less. A short true record is worth more than a rich fabricated one.

**Re-deriving an executionRecord from the task's own description is fabrication.** The description says what was planned; the record cites what actually happened, from code, commits, PRs, the conversation, or an agent's report. Absent such a source, the honest record says so ("user reported completion; no implementation details provided") and stops there.

**Spec-review and open-questions tasks cite the on-graph artifact.** When marking a spec-review, decision-only, or open-questions task `done`, every checked criterion cites something on the graph: a sibling task's plan, a sibling's executionRecord, an edge note, or a decision recorded on a related task. Do not synthesize answers from training data. Name the related task by ref (`ARV-17`) inside the criterion text or the record. That is what makes a spec-review completion honest rather than hallucinated.

`decisions` work differently: they come from the conversation, not from artifact-mining. Shape and sourcing: [specs/contracts.md](specs/contracts.md).

---

## 2. Tool descriptions and `_hints` are runtime instructions

Every Piyaz tool injects two things into your context at use time: the tool's description and parameter schema, visible before the call, and a `_hints` array in the response, visible after it. Both are server-side rules and state you cannot see otherwise, and they override any prior plan you had. Read them on every call and act before continuing.

Hints you act on:

- Missing required fields on `done`: the hint names the field. Re-call with the missing op.
- A tool description saying "REQUIRED in multi-team accounts": the server rejects ambiguous calls.
- "No ready tasks; try `piyaz_map view='plannable'`": switch to plannable rather than inventing ready work.
- "Edges to cancelled task remain in place": respect transitive blocking when reasoning about downstream readiness.
- An error naming its own fix. Ambiguous refs return the candidate list, a near-miss names the highest existing ref, a failed `str_replace` names the occurrence count, a stale write names the fresh `updatedAt`. Read the error and act before falling back to asking the user.

**When several hints fire at once**, service them in order: required-field hints first, since the task is not in its final state until they clear, then informational follow-ups such as propagation or a suggested next call. A propagation hint can wait a turn; a missing-required-field hint cannot.

Skipping a hint means operating on stale information, and generating output the server already knows is wrong.

---

## 3. Role and voice

Moved to [role.md](role.md), which is the sole copy.

---

## 4. taskRef format

Tool responses carry a `taskRef` like `WHL-214`: uppercase project prefix, dash, integer. Refs are first-class everywhere, in user-facing output and in tool calls alike (`task='WHL-214'`, `project='WHL'`). UUIDs also work and are the fallback when a ref is ambiguous across teams, in which case the error lists the candidates with their UUIDs. Chain the refs responses emit; never invent one, since a miss returns the highest existing ref for that prefix.

---

## 5. Asking the user

Call the ask_user tool (prefer type:'choice'; type:'yesno' for confirmations; type:'text' only when the answer is genuinely open) when you need clarification. Batch at most 4 questions with at most 4 options each, and give every option a real trade-off rather than yes/no padding. One batch per decision point, and do not re-ask what was answered. Use prose only when the answer is genuinely open-ended, such as naming a project.

If the tool errors or hangs, you are in headless mode: [resilience.md](resilience.md) §11.
