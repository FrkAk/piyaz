/**
 * MCP tool input schemas, descriptions, and metadata for the 6 Mymir tools.
 *
 * Standalone module with no data-layer imports so it can be consumed by
 * both the MCP server (lib/mcp/create-server.ts) and the docs generator
 * (scripts/generate-docs.ts).
 */
import { z } from "zod/v4";
import { identifierSchema } from "@/lib/graph/identifier";

/**
 * Per-field anti-abuse ceilings for MCP tool inputs. These are deliberately
 * GENEROUS, not content policy: agents legitimately write long unabridged
 * implementation plans and execution records (the tool instructions say "do
 * not summarize"), so the caps sit far above any real payload and exist only
 * to stop a single field carrying tens of megabytes. The operative bound on
 * total cost is the request body-size limit on the `/api/mcp` route
 * (`MAX_MCP_BODY_BYTES`) — these field caps are defense in depth so no one
 * field can consume the whole budget.
 */
export const LIMITS = {
  title: 1_000,
  description: 100_000,
  plan: 1_000_000,
  executionRecord: 500_000,
  decision: 50_000,
  criterionText: 50_000,
  edgeNote: 50_000,
  tag: 200,
  category: 200,
  filePath: 4_000,
  query: 2_000,
  arrayItems: 1_000,
  files: 5_000,
  tags: 500,
} as const;

// ---------------------------------------------------------------------------
// Shared descriptions (MCP tools are ground truth)
//
// Tool descriptions are loaded on every agent turn — every word is paid
// N×turns. Each line below earns its place: purpose, per-action steering,
// a critical limitation or rule, the next-call cue. Doctrine (tag
// taxonomy, AC quality, category vocab, full lifecycle table, persona)
// lives in the skill's reference files; the server steers the agent
// toward the right rule rather than restating it.
// ---------------------------------------------------------------------------

/** Tool descriptions shared between the MCP server and the docs generator. */
export const DESCRIPTIONS = {
  mymir_project:
    "List, create, and update projects, plus enumerate team memberships. Spans every team the caller belongs to; no server-side session state, so pass projectId explicitly on every downstream call. " +
    "list=projects (id, title, identifier, status, team chip, task counts, progress); skips empty teams; description and tag vocab fetched on demand via mymir_query type='meta'. " +
    "teams=every membership (id, name, slug, role, projectCount); call before create or when list misses a team. " +
    "select=confirm working project; pass returned projectId on every subsequent call. " +
    "create=new project; multi-team accounts MUST pass organizationId (server rejects ambiguous calls with the team list inline; auto-resolves single-team). " +
    "update=title, description, status, categories, or identifier. Renaming identifier cascades every taskRef and breaks external references (PR titles, docs, commits).",
  mymir_task:
    "Create, update, or delete tasks. Lifecycle: draft → planned → in_progress → in_review → done. The implementer subagent's terminal write is `in_review` (PR opened, tests green); the HOTL gate flips to `done` after PR approval. cancelled is terminal abandoned work with transparent dep semantics (dependents stay blocked through the cancelled task's own unsatisfied prereqs; populate executionRecord with rationale). " +
    "create requires title (verb+noun, imperative), description (2-4 sentences; single-sentence rejected), 2-4 binary acceptanceCriteria, three tag dimensions (work-type, cross-cutting, tech), one project category. priority, estimate, and assigneeIds are first-class fields, not tags: priority (urgent / core / normal / backlog), estimate (Fibonacci story points 1/2/3/5/8/13), assigneeIds (array of team-member user UUIDs). After create: search precedents/coordinators by verb+noun+surface, wire mymir_edge, verify with mymir_query type='edges'. Bare tasks orphan from critical_path, downstream, depth='agent'. " +
    "update: pass only changed fields. Array fields (acceptanceCriteria, decisions, files, assigneeIds) APPEND by default; overwriteArrays=true REPLACES them. Destructive, NO undo (history is an audit log); confirm with user first. " +
    "delete: preview=true (default) shows impact; preview=false executes. Prefer status='cancelled' for abandoned scope so the rationale is preserved. " +
    "Done means: executionRecord (3-5 sentences, what was built), decisions (CHOICE+WHY), files (every path), acceptanceCriteria evaluated. Open a PR if files non-empty; run mymir_analyze type='downstream' to propagate.",
  mymir_edge:
    "Create, update, or remove dependency edges between tasks. depends_on=source needs target's output (target must be done first). relates_to=informational link, neither blocks the other. Litmus test: removing the target makes the source impossible → depends_on; just makes it harder → relates_to. " +
    "create: edge note REQUIRED and substantive; notes propagate to downstream agent context, and placeholders ('needed', 'depends') are rejected. Write it as a brief to the developer about to start the source task. " +
    "update: change edgeType or note by edgeId. " +
    "remove: by edgeId OR by sourceTaskId+targetTaskId+edgeType. " +
    "Server rejects self-edges, duplicates, and cycles. On 'duplicate edge' (concurrent-write race): treat as success and verify with mymir_query type='edges'.",
  mymir_query:
    "Search and browse project data. Pick the slim tool first; reserve overview for unfamiliar projects. " +
    "search=tasks by taskRef, title, or tag substring (case-insensitive, up to 20). Pass tags=[...] for exact tag match (OR-within); combine with `query` to AND-narrow. Pass category='...' for exact project-category match (closed vocabulary; unknown values rejected with the valid list inline); combines with query/tags via AND. Single-result responses include a state hint pointing to the right next call. " +
    "list=every task in the project (slim, ordered by position). " +
    "edges=relationships on one task (connected title, status, direction, note). " +
    "meta=slim project metadata: header, description, status, categories, tag vocabulary (with usage counts), progress + status counts. No task list, no edges. Use this to look up categories before setting one, or the tag vocabulary before coining new tags. " +
    "overview=full project structure: every task, every edge, full tag vocab, progress. VERY HEAVY. Reserve for unfamiliar-project orientation, decompose's pre-write coverage check, or strategic review. At most once per session. For just categories or tag vocab, use meta.",
  mymir_context:
    "Retrieve task context at varying depth. ALWAYS fetch context before reasoning about a task; pick the lightest depth that answers the question. " +
    "summary=task header + description + counts (criteria, decisions, plan flag, edge counts) + full 1-hop edges WITH notes. The lightest depth that still carries edge notes; folds in what `mymir_query type='edges'` would give. " +
    "working=detailed (criteria, decisions, 1-hop edges) for refinement and review. " +
    "agent=multi-hop dependency chains with upstream execution records (~4-8K tokens); fetch BEFORE coding. " +
    "planning=spec-focused (project description, prereqs, acceptance criteria, downstream specs); fetch BEFORE writing the implementation plan.",
  mymir_analyze:
    "Analyze the project dependency graph. All variants slim; lead with these for status, prioritization, 'what's next', 'what's stuck'. " +
    "critical_path=longest dep chain (project bottleneck, minimum duration). Lead with this on continue / resume / 'guide me forward'; the most important type for prioritization. " +
    "ready=planned tasks with all effective deps done (only `status='planned'` reaches this state; drafts with satisfied deps surface as `plannable`, not `ready`). Pick from `ready ∩ critical_path` for the highest-impact unblocked work. " +
    "plannable=draft tasks with description + criteria, ready for planning. Fall back here when nothing is ready to code. " +
    "blocked=tasks waiting on unfinished deps with blocker details. " +
    "downstream=transitive dependents of one task; impact analysis before status change, refinement, or cancellation.",
} as const;

export const projectInputSchema = z.object({
  action: z
    .enum(["list", "teams", "create", "select", "update"])
    .describe(
      "list=projects across every team you belong to (id, title, identifier, status, team chip, task counts, progress); skips empty teams; description and tag vocab fetched on demand via mymir_query type='meta'. teams=every membership (id, name, slug, role, projectCount); call before create or when list misses a team. create=new project (requires organizationId in multi-team accounts). select=confirm working project (returns projectId). update=modify fields.",
    ),
  projectId: z
    .uuid()
    .optional()
    .describe("Project UUID. Required for select and update."),
  title: z
    .string()
    .max(LIMITS.title)
    .optional()
    .describe(
      "Project name (2-5 words, verb-noun preferred). Required for create.",
    ),
  description: z
    .string()
    .max(LIMITS.description)
    .optional()
    .describe(
      "3-5 sentence brief: problem, user, features, tech direction, constraints.",
    ),
  status: z
    .enum(["brainstorming", "decomposing", "active", "archived"])
    .optional()
    .describe(
      "Lifecycle: brainstorming → decomposing → active → archived. Settable on create (defaults to 'brainstorming') or update.",
    ),
  categories: z
    .array(z.string().max(LIMITS.category))
    .max(LIMITS.arrayItems)
    .optional()
    .describe(
      "Task categories for this project (e.g. ['backend', 'frontend', 'mcp']). Drives drawer grouping in the UI.",
    ),
  identifier: identifierSchema
    .optional()
    .describe(
      "Project prefix for task refs (e.g. 'MYM' yields MYM-1, MYM-2, ...). 2-12 chars, uppercase alphanumeric, unique per team. Auto-derived from title on create when omitted. On update: renames every existing task ref; external references (PR titles, docs) no longer resolve.",
    ),
  organizationId: z
    .uuid()
    .optional()
    .describe(
      "Target team UUID for create. REQUIRED when you're a member of more than one team; the create is rejected with the team list inline otherwise. Auto-resolved when you belong to exactly one team. Membership is verified server-side; non-member targets return 'forbidden'.",
    ),
});

export const taskInputSchema = z.object({
  action: z
    .enum(["create", "update", "delete"])
    .describe(
      "create=new task. update=modify fields (pass only what changed). delete=remove (preview by default).",
    ),
  taskId: z
    .uuid()
    .optional()
    .describe(
      "Task UUID (not the 'MYM-N' taskRef; refs are display-only). Required for update/delete.",
    ),
  projectId: z
    .uuid()
    .optional()
    .describe(
      "Project UUID. Required for create. Project's team scope is inherited.",
    ),
  title: z
    .string()
    .max(LIMITS.title)
    .optional()
    .describe(
      "Verb+noun, imperative. Required for create (e.g. 'Implement JWT auth', not 'Auth'). Artifacts §1.",
    ),
  description: z
    .string()
    .max(LIMITS.description)
    .optional()
    .describe(
      "2-4 sentences (up to 6-8 for genuinely complex tasks; single-sentence rejected): what + who it serves + where it fits in the architecture. Required for create. Artifacts §1.",
    ),
  status: z
    .enum(["draft", "planned", "in_progress", "in_review", "done", "cancelled"])
    .optional()
    .describe(
      "Lifecycle: draft → planned → in_progress → in_review → done. The implementer subagent's terminal write is `in_review` (PR opened, tests green); the HOTL gate flips to `done` after PR approval. cancelled = terminal abandoned work; populate executionRecord with rationale. Cancelled deps are transparent: dependents stay blocked through the cancelled task's own unsatisfied deps. Excluded from progress and critical path.",
    ),
  acceptanceCriteria: z
    .array(
      z.union([
        z.string().max(LIMITS.criterionText),
        z.object({
          id: z.string().max(LIMITS.tag).optional(),
          text: z.string().max(LIMITS.criterionText),
          checked: z.boolean().optional(),
        }),
      ]),
    )
    .max(LIMITS.arrayItems)
    .optional()
    .describe(
      "2-4 binary items (reviewer answers YES/NO; single-AC and vague ACs like 'works correctly' rejected). Pass strings for new criteria, or {text, checked} objects to evaluate existing rows. Artifacts §1.",
    ),
  decisions: z
    .array(z.string().max(LIMITS.decision))
    .max(LIMITS.arrayItems)
    .optional()
    .describe(
      "Technical choices and constraints. One-liner per decision (CHOICE + WHY).",
    ),
  tags: z
    .array(z.string().max(LIMITS.tag))
    .max(LIMITS.tags)
    .optional()
    .describe(
      "Kebab-case. Every task carries three tag dimensions: exactly 1 work-type (bug/feature/refactor/docs/test/chore/perf), ≥1 cross-cutting concern (open: quality attribute or feature cluster), at most 2 tech tags (most important stack pieces touched). Priority is the `priority` field, not a tag. Do NOT tag codebase area (use category) or status. Run mymir_query type='meta' before coining new tags.",
    ),
  category: z
    .string()
    .max(LIMITS.category)
    .optional()
    .describe(
      "Architectural layer / subsystem this task belongs to (exactly one). Reuse a project category; do not silently coin mid-task. The project's 4-8 categories are set on creation or via decompose/onboarding gates. Run mymir_query type='meta' to see them. Artifacts §4.",
    ),
  priority: z
    .enum(["urgent", "core", "normal", "backlog"])
    .optional()
    .describe(
      "Priority of the task. urgent: cannot ship without; core: central to the release; normal: routine; backlog: deprioritized.",
    ),
  estimate: z
    .union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(5),
      z.literal(8),
      z.literal(13),
    ])
    .optional()
    .describe(
      "Fibonacci story-point estimate. 1 = trivial, 2/3 = routine, 5 = nontrivial, 8/13 = risky or multi-day. If a task feels >13, split it (artifacts §5).",
    ),
  assigneeIds: z
    .array(z.uuid())
    .max(LIMITS.arrayItems)
    .optional()
    .describe(
      "User UUIDs to assign to this task. Each must be a member of the project's owning team; non-members are rejected. The single-worker `in_progress` invariant still applies; assignees declare ownership / intent, not concurrent claim. APPENDS by default on update; `overwriteArrays=true` REPLACES the full set.",
    ),
  files: z
    .array(z.string().max(LIMITS.filePath))
    .max(LIMITS.files)
    .optional()
    .describe(
      "Repo-relative paths created or modified (no leading slash, no absolute). Pass `files=[]` when nothing was touched (unscaffolded repo, research/spec-review/decision-only); never invent paths.",
    ),
  implementationPlan: z
    .string()
    .max(LIMITS.plan)
    .optional()
    .describe(
      "Implementation plan (markdown, unabridged; do not summarize). Pass with `status='planned'` to transition draft → planned; without the status change the task stays incomplete (lifecycle §1).",
    ),
  executionRecord: z
    .string()
    .max(LIMITS.executionRecord)
    .optional()
    .describe(
      "3-5 sentences on HOW it was built (function names, file paths, endpoints; distinct from description=scope). For cancelled: rationale + what was tried instead. Draft tasks must not carry this. Iron Law: cite real code, omit what you cannot. Markdown. Artifacts §1.",
    ),
  prUrl: z
    .url()
    .nullable()
    .optional()
    .describe(
      "PR URL for this task's code change. Sugar field that upserts a `task_links` row with kind derived from the URL classifier (`pull_request` for github.com/.../pull/N, gitlab.com/.../merge_requests/N). Pass alongside `status='in_review'` in the Completion Protocol payload; the composer-implementer subagent writes this in the same call as executionRecord/decisions/files/acceptanceCriteria. Pass `null` to remove an existing PR link. Other link kinds (issues, commits, docs) are user-managed via the UI; only PRs are agent-write today.",
    ),
  preview: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Delete only: true=show impact (default), false=actually delete.",
    ),
  overwriteArrays: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Update only. true=replace decisions/acceptanceCriteria/files; default false=append. Destructive, NO undo; confirm with user first.",
    ),
});

export const edgeInputSchema = z.object({
  action: z
    .enum(["create", "update", "remove"])
    .describe(
      "create=new edge. update=modify type or note. remove=delete by edgeId or by source+target+type.",
    ),
  edgeId: z
    .uuid()
    .optional()
    .describe(
      "Edge UUID. Required for update. For remove: use this OR sourceTaskId+targetTaskId+edgeType.",
    ),
  sourceTaskId: z
    .uuid()
    .optional()
    .describe(
      "Source task UUID. Required for create. Alternative key for remove.",
    ),
  targetTaskId: z
    .uuid()
    .optional()
    .describe(
      "Target task UUID. Required for create. Alternative key for remove.",
    ),
  edgeType: z
    .enum(["depends_on", "relates_to"])
    .optional()
    .describe(
      "depends_on = source needs target done first. relates_to = informational link, neither blocks the other. Required for create.",
    ),
  note: z
    .string()
    .max(LIMITS.edgeNote)
    .optional()
    .describe(
      "Why this relationship exists. Propagates to agent context for downstream tasks, so write it as a brief to the developer about to start the source task: what specifically does this task get from the target? REQUIRED on create; placeholders ('needed', 'depends', 'related') are rejected.",
    ),
});

export const queryInputSchema = z.object({
  type: z
    .enum(["search", "list", "edges", "meta", "overview"])
    .describe(
      "search=find tasks by taskRef, title, or tag (case-insensitive, up to 20). list=all tasks ordered by position. edges=relationships on a task. meta=slim project metadata (header, categories, tag vocab with counts, progress); use to look up categories or tag vocab without overview. overview=full project structure with progress + tag vocab + every task + every edge.",
    ),
  query: z
    .string()
    .max(LIMITS.query)
    .optional()
    .describe(
      "Search string for type='search'. Matches taskRef, title substring, or tag substring. Optional when `tags` is provided.",
    ),
  tags: z
    .array(z.string().max(LIMITS.tag))
    .max(LIMITS.tags)
    .optional()
    .describe(
      "Filter to tasks containing ANY of these exact tags (OR-within). Combine with `query` to narrow further. Pick from the tag vocabulary in `type='meta'`.",
    ),
  category: z
    .string()
    .max(LIMITS.category)
    .optional()
    .describe(
      "Filter to tasks in exactly this category (AND with `query`/`tags`). Must be one of the project's categories (closed vocabulary); unknown values are rejected. Run mymir_query type='meta' for the current list.",
    ),
  taskId: z.uuid().optional().describe("Task UUID for type='edges'."),
  projectId: z
    .uuid()
    .optional()
    .describe("Project UUID. Required for search/list/meta/overview."),
});

export const contextInputSchema = z.object({
  taskId: z.uuid().describe("Task UUID."),
  depth: z
    .enum(["summary", "working", "agent", "planning", "review"])
    .default("working")
    .describe(
      "summary=task header + description + counts + 1-hop edges with notes (folds in `mymir_query type='edges'`). working=criteria, decisions, 1-hop edges (both depends_on and relates_to, both directions, with notes) — does NOT render executionRecord, files, or implementationPlan. agent=multi-hop deps + upstream execution records (each with its PR link) + downstream; includes a ⚠ Blocked section when direct prerequisites are unfinished; for done/cancelled tasks returns the retrospective record bundle (project, what the task was, outcome, decisions, PR link) instead of the implementation shape (use BEFORE coding, and to read a finished task's record). No bundle renders recorded file lists — the linked PR diff is the source of truth for what changed. planning=project description, prereqs, ACs, downstream specs, links, and abandoned approaches (cancelled-dep execution records with their closed-PR links) (use BEFORE writing the implementation plan). review=in_review review bundle: implementationPlan alongside executionRecord, PR link surfaced, AC evaluation, downstream impact, review-lens prompts (security / perf / reliability / observability / codebase standards); review the actual changes from the PR diff. The review subagent reads this depth.",
    ),
  projectId: z
    .uuid()
    .optional()
    .describe("Project UUID. Required for 'working' depth."),
});

export const analyzeInputSchema = z.object({
  type: z
    .enum(["ready", "blocked", "downstream", "critical_path", "plannable"])
    .describe(
      "ready=planned tasks with all deps done (drafts with deps satisfied surface as plannable, not ready). blocked=waiting tasks with blocker details. downstream=transitive dependents (impact analysis before changes). critical_path=longest dep chain (project bottleneck). plannable=draft tasks with description+criteria, ready for planning.",
    ),
  taskId: z.uuid().optional().describe("Task UUID. Required for 'downstream'."),
  projectId: z
    .uuid()
    .optional()
    .describe(
      "Project UUID. Required for ready/blocked/critical_path/plannable.",
    ),
});

/** One tool's docs-relevant surface. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
}

/** All 6 tools in registration order. Titles match the MCP annotations. */
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "mymir_project",
    title: "Manage Project",
    description: DESCRIPTIONS.mymir_project,
    inputSchema: projectInputSchema,
  },
  {
    name: "mymir_task",
    title: "Manage Task",
    description: DESCRIPTIONS.mymir_task,
    inputSchema: taskInputSchema,
  },
  {
    name: "mymir_edge",
    title: "Manage Edge",
    description: DESCRIPTIONS.mymir_edge,
    inputSchema: edgeInputSchema,
  },
  {
    name: "mymir_query",
    title: "Query Tasks",
    description: DESCRIPTIONS.mymir_query,
    inputSchema: queryInputSchema,
  },
  {
    name: "mymir_context",
    title: "Get Task Context",
    description: DESCRIPTIONS.mymir_context,
    inputSchema: contextInputSchema,
  },
  {
    name: "mymir_analyze",
    title: "Analyze Graph",
    description: DESCRIPTIONS.mymir_analyze,
    inputSchema: analyzeInputSchema,
  },
] as const;
