/**
 * MCP tool input schemas, descriptions, and metadata for the 8 Piyaz tools.
 *
 * Standalone module with no data-layer imports so it can be consumed by
 * both the MCP server (lib/mcp/create-server.ts) and the docs generator
 * (scripts/generate-docs.ts).
 *
 * Identifier convention: every task parameter accepts a taskRef like
 * `PYZ-42` or a task UUID; every project parameter accepts a project
 * identifier like `PYZ` or a project UUID. The params are plain strings
 * (never Zod unions — upfront schema loaders handle `anyOf` inconsistently)
 * and the server resolves them, returning corrective errors with candidate
 * lists on ambiguity and near-miss suggestions on a miss.
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
  ref: 64,
  batchTasks: 25,
  batchEdges: 100,
  editOps: 20,
  url: 4_000,
  isoTimestamp: 64,
  cursor: 512,
} as const;

/** A task handle: taskRef (`PYZ-42`) or task UUID. */
const taskRefParam = z.string().max(LIMITS.ref);

/** A project handle: project identifier (`PYZ`) or project UUID. */
const projectRefParam = z.string().max(LIMITS.ref);

/** The literal `me` or a user UUID; shared by assignee-bearing params. */
const ME_OR_UUID_RE =
  /^(me|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** Task fields addressable by `piyaz_get fields=[...]`. Mirrors
 * `TASK_FIELD_NAMES` in `lib/db/raw/fetch-task-full.ts`. */
export const TASK_FIELD_ENUM = [
  "title",
  "description",
  "status",
  "category",
  "priority",
  "estimate",
  "tags",
  "files",
  "implementationPlan",
  "executionRecord",
  "acceptanceCriteria",
  "decisions",
  "links",
  "assignees",
] as const;

/** Task lifecycle statuses, in progression order. */
const TASK_STATUS_ENUM = [
  "draft",
  "planned",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

/** Task priority levels, most to least urgent. */
const PRIORITY_ENUM = ["urgent", "core", "normal", "backlog"] as const;

/** Fibonacci story-point estimate. */
const estimateSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
  z.literal(13),
]);

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
  piyaz_workspace:
    "Session-start tool: identify the caller and manage projects across every team they belong to. There is no 'active' team or server-side session; responses emit project identifiers (e.g. 'PYZ') that every other tool accepts directly. " +
    "whoami=caller identity (user id, name, team count); run once at session start. " +
    "teams=every membership (id, name, slug, role, projectCount) including empty teams. " +
    "projects=all projects with identifier, status, team chip, task counts, progress; skips empty teams, so pair with teams for the full set. " +
    "members=one team's directory (name, user UUID, role): the UUID source for assigneeIds, assignee ops, and assignee filters. " +
    "create=new project; multi-team accounts MUST pass organizationId (server rejects ambiguous calls with the team list inline). " +
    "update=title, description, status, categories, or identifier. Renaming the identifier cascades every taskRef and breaks external references (PR titles, docs, commits); categories=[...] replaces the vocabulary WITHOUT touching task rows. " +
    "rename_category/delete_category=vocabulary edits that cascade to task rows atomically. " +
    "Next: piyaz_search to find work, piyaz_map view='ready' to find unblocked tasks.",
  piyaz_search:
    "Universal task finder. Cross-project across every team by default; pass project='PYZ' to scope. At least one criterion required: query (matches taskRef, title, tags), status[], priority[], assignee ('me' or a user UUID), category, or tags[] (AND-within). " +
    "Results are newest-updated first with a cursor when more pages exist; project-scoped results carry the derived state (ready/blocked/plannable). " +
    "Every result line leads with the taskRef — chain it straight into piyaz_get, piyaz_edit, or piyaz_link. Narrow with filters instead of paging when a page overflows.",
  piyaz_get:
    "Read one task or one project. Pass exactly one of task ('PYZ-42' or UUID) or project ('PYZ' or UUID). ALWAYS fetch before reasoning about a task; pick the lightest shape that answers the question. " +
    "Task lenses: summary=header+description+counts+1-hop edges with notes (lightest with edges). working=criteria with ids, decisions with ids, links with ids, 1-hop edges — the edit-address read. agent=multi-hop deps + upstream execution records + related tasks (~4-8K tokens); fetch BEFORE coding; terminal tasks return the retrospective record instead. planning=project description, prereqs, work-so-far, downstream specs, abandoned approaches; fetch BEFORE writing a plan. review=implementationPlan beside executionRecord + PR link + review-lens prompts (for in_review tasks). record=retrospective for done/cancelled tasks. " +
    "fields=[...]: raw single-field read (lens ignored); the cheapest way to fetch one field's exact text before a piyaz_edit str_replace, or collection ids before by-id ops; response includes updatedAt for ifUpdatedAt preconditions. " +
    "Project: view='meta' (categories, tag vocabulary, progress — check before setting category or coining tags) or view='overview' (every task + edge; HEAVY, at most once per session; truncated groups name the piyaz_search filter to narrow with).",
  piyaz_create:
    "Create 1-25 tasks in one project, optionally with edges between them, in one atomic call. Requires project ('PYZ' or UUID) and tasks[]; each task needs title (verb+noun, imperative) and description (2-4 sentences; single-sentence flagged). Give each task a key to reference it in edges; edge source/target accept keys, taskRefs, or UUIDs. " +
    "Idempotent: exact-title matches against existing tasks are skipped and returned as 'deduped' (reusable as edge endpoints), so a restarted decompose run never duplicates a task set; onDuplicate='error' rejects the whole batch instead. Edges that already exist are silently skipped. " +
    "Include acceptanceCriteria (2-4 binary), tags (three dimensions), category (from piyaz_get project view='meta'), priority, estimate up front — hints flag what's missing. " +
    "Next: verify wiring with piyaz_map view='neighbors' task='<ref>'.",
  piyaz_edit:
    "Edit one task with an ordered list of operations, applied atomically (all or nothing). task accepts 'PYZ-42' or a UUID. " +
    "Text fields (description, implementationPlan, executionRecord): op='str_replace' (oldStr must match exactly once; the error names the occurrence count), op='append' (adds a paragraph), op='set' (full replace — prefer str_replace/append for surgical edits). " +
    "Collections (acceptanceCriteria, decisions, links, assignees): op='add' (text/url; assignees take value='me' or a user UUID), op='update'/'remove'/'check'/'uncheck' by the item id from piyaz_get lens='working' or fields=[...] (assignees support add/remove only). Removed items are unrecoverable. " +
    "Scalars (status, priority, estimate, category, title, tags, files, prUrl): op='set' with value. Status transitions return lifecycle hints — read and act on them. " +
    "ifUpdatedAt (from a prior read) makes the whole call a compare-and-swap for contended tasks. " +
    "op='delete_task' must be the only op: preview defaults to true (impact summary); preview=false executes. Prefer set status='cancelled' for abandoned scope — delete only pure noise.",
  piyaz_link:
    "Create, update, or remove dependency edges. source/target accept 'PYZ-42' or UUIDs. depends_on=source needs target's output (target must finish first). relates_to=informational, neither blocks. Litmus: removing the target makes the source impossible → depends_on; merely harder → relates_to. " +
    "create=new edge; note REQUIRED and substantive (placeholders 'needed'/'depends'/'related' rejected) — write it as a brief to the developer starting the source task. " +
    "update=rewrite the note, keyed by source+target+type (type is the lookup key there; pass edgeId to also change type). To re-type without an edgeId: remove, then create with a fresh note. remove=same keys. " +
    "Server rejects self-edges, duplicates, and cycles (the error names the chain). On 'duplicate edge': treat as success. Verify with piyaz_map view='neighbors'.",
  piyaz_map:
    "Navigate the dependency graph. Lead with these for 'what's next', 'what's stuck', impact analysis. " +
    "ready=planned tasks with all deps done (drafts surface under plannable, not ready); pick from ready ∩ critical_path for highest-impact work. " +
    "blocked=waiting tasks with blocker details. plannable=drafts with description+criteria, ready for planning. " +
    "critical_path=longest dependency chain (the project bottleneck); lead with this on resume / 'guide me forward'. " +
    "downstream=transitive dependents of one task; run before status changes, refinement, or cancellation. " +
    "neighbors=1-2 hops around one task, both edge types, both directions, with notes — the context-network walk; every line is ref-chainable into piyaz_get. " +
    "ready/blocked/plannable/critical_path need project; downstream/neighbors need task.",
  piyaz_activity:
    "What changed, newest first, keyset-paginated. Pass exactly one of project ('PYZ' or UUID) or task ('PYZ-42' or UUID). " +
    "since (ISO timestamp) answers 'what changed since I left' — the resume-after-compaction primitive: piyaz_activity project='PYZ' since='<last known instant>'. " +
    "Events carry actor, type, summary, and target ref. Follow up on a specific task with piyaz_get.",
} as const;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const workspaceInputSchema = z.object({
  action: z
    .enum([
      "whoami",
      "teams",
      "projects",
      "members",
      "create",
      "update",
      "rename_category",
      "delete_category",
    ])
    .describe(
      "whoami=caller identity: user id, display name, team count; run at session start. teams=every membership (id, name, slug, role, projectCount), including empty teams. projects=projects across every team (identifier, title, status, team chip, task counts, progress); skips empty teams. members=one team's directory (name, user UUID, role) — the UUID source for assigneeIds, assignee ops, and assignee filters; organizationId picks the team (auto-resolved for single-team accounts). create=new project (organizationId REQUIRED for multi-team accounts). update=modify title, description, status, categories, or identifier. rename_category=rename a vocabulary entry AND move every task in it, atomically. delete_category=remove a vocabulary entry and uncategorize its tasks.",
    ),
  project: projectRefParam
    .optional()
    .describe(
      "Project identifier ('PYZ') or project UUID. Required for update.",
    ),
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
      "update only: FULL REPLACEMENT of the project's category vocabulary (e.g. ['backend', 'frontend', 'mcp']). Does not touch task rows — renaming or removing an in-use entry this way orphans its tasks; use rename_category / delete_category for cascades. Best for adding entries or reordering.",
    ),
  category: z
    .string()
    .max(LIMITS.category)
    .optional()
    .describe(
      "rename_category/delete_category: the existing entry, exactly as listed by piyaz_get project view='meta'.",
    ),
  newCategory: z
    .string()
    .max(LIMITS.category)
    .optional()
    .describe(
      "rename_category only: the replacement name. Must not already exist — merge by re-categorizing tasks instead.",
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
      "Target team UUID for create and members. REQUIRED when you're a member of more than one team; the call is rejected with the team list inline otherwise. Auto-resolved when you belong to exactly one team. Membership is verified server-side; non-member targets return 'not found'.",
    ),
});

export const searchInputSchema = z.object({
  query: z
    .string()
    .max(LIMITS.query)
    .optional()
    .describe(
      "Free-text match on taskRef, title, or tag substring (case-insensitive). Optional when any filter is set.",
    ),
  project: projectRefParam
    .optional()
    .describe(
      "Project identifier ('PYZ') or UUID to scope the search. DEFAULT: cross-project across every team you belong to. Project-scoped results include the derived state (ready/blocked/plannable/...).",
    ),
  status: z
    .array(z.enum(TASK_STATUS_ENUM))
    .max(TASK_STATUS_ENUM.length)
    .optional()
    .describe("Lifecycle statuses to include (OR-within)."),
  priority: z
    .array(z.enum(PRIORITY_ENUM))
    .max(PRIORITY_ENUM.length)
    .optional()
    .describe("Priorities to include (OR-within)."),
  assignee: z
    .string()
    .max(LIMITS.ref)
    .regex(ME_OR_UUID_RE, "assignee must be the literal 'me' or a user UUID")
    .optional()
    .describe("Filter to tasks assigned to 'me' (the caller) or a user UUID."),
  category: z
    .string()
    .max(LIMITS.category)
    .optional()
    .describe(
      "Exact project-category match. See the project's vocabulary via piyaz_get project view='meta'.",
    ),
  tags: z
    .array(z.string().max(LIMITS.tag))
    .max(LIMITS.tags)
    .optional()
    .describe(
      "Exact tags; every listed tag must be present (AND-within). Pick from the vocabulary in piyaz_get project view='meta'.",
    ),
  limit: z
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Page size, 1-50 (default 20)."),
  cursor: z
    .string()
    .max(LIMITS.cursor)
    .optional()
    .describe(
      "Opaque cursor from a previous page's nextCursor. Prefer narrowing filters over deep paging.",
    ),
});

export const getInputSchema = z.object({
  task: taskRefParam
    .optional()
    .describe(
      "taskRef ('PYZ-42') or task UUID. Pass exactly one of task or project.",
    ),
  project: projectRefParam
    .optional()
    .describe(
      "Project identifier ('PYZ') or project UUID. Pass exactly one of task or project.",
    ),
  lens: z
    .enum(["summary", "working", "agent", "planning", "review", "record"])
    .optional()
    .describe(
      "Task reads only; default 'working'. summary=header + description + counts + 1-hop edges with notes (lightest with edges). working=criteria/decisions/links WITH their ids (the edit-address read) + 1-hop edges. agent=multi-hop deps + upstream execution records + related (non-blocking) tasks; fetch BEFORE coding; done/cancelled tasks return the retrospective record instead. planning=project description, prereqs, work-so-far, downstream specs, abandoned approaches; fetch BEFORE writing the implementation plan. review=implementationPlan alongside executionRecord, PR link, AC evaluation, review-lens prompts; for in_review tasks. record=retrospective bundle (outcome, decisions, PR link) for done/cancelled tasks.",
    ),
  view: z
    .enum(["meta", "overview"])
    .optional()
    .describe(
      "Project reads only; default 'meta'. meta=header, description, status, categories, tag vocabulary with counts, progress; the cheap lookup before setting a category or coining tags. overview=every task grouped by status plus every edge; HEAVY, at most once per session; over-limit groups are truncated with the narrowing piyaz_search filter named inline.",
    ),
  fields: z
    .array(z.enum(TASK_FIELD_ENUM))
    .min(1)
    .max(TASK_FIELD_ENUM.length)
    .optional()
    .describe(
      "Task reads only. Raw field read: returns exactly these fields' current values (lens ignored) plus updatedAt for ifUpdatedAt preconditions. Collection fields include item ids for piyaz_edit by-id ops. The cheapest read before a surgical edit — fetch ['implementationPlan'] to copy exact text for str_replace.",
    ),
  detail: z
    .enum(["concise", "detailed"])
    .optional()
    .describe(
      "Project overview only. concise (default) drops the tag vocabulary and per-task tags; detailed includes them.",
    ),
  limit: z
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Project overview only: per-status task-group cap (default 30). Truncated groups name the piyaz_search filter to fetch the rest.",
    ),
});

/** One task in a `piyaz_create` batch. */
const createTaskItemSchema = z.object({
  key: z
    .string()
    .max(LIMITS.ref)
    .optional()
    .describe(
      "Local handle naming this task for edges within the same call (e.g. key='auth' then edges:[{source:'auth', ...}]).",
    ),
  title: z
    .string()
    .min(1)
    .max(LIMITS.title)
    .describe("Verb+noun, imperative (e.g. 'Implement JWT auth', not 'Auth')."),
  description: z
    .string()
    .min(1)
    .max(LIMITS.description)
    .describe(
      "2-4 sentences (up to 6-8 for genuinely complex tasks; single-sentence flagged): what + who it serves + where it fits.",
    ),
  status: z
    .enum(TASK_STATUS_ENUM)
    .optional()
    .describe(
      "Defaults to 'draft'. Lifecycle: draft → planned → in_progress → in_review → done.",
    ),
  acceptanceCriteria: z
    .array(z.string().max(LIMITS.criterionText))
    .max(LIMITS.arrayItems)
    .optional()
    .describe("2-4 binary done-conditions (reviewer answers YES/NO)."),
  decisions: z
    .array(z.string().max(LIMITS.decision))
    .max(LIMITS.arrayItems)
    .optional()
    .describe("Technical choices, one line each: CHOICE + WHY."),
  tags: z
    .array(z.string().max(LIMITS.tag))
    .max(LIMITS.tags)
    .optional()
    .describe(
      "Kebab-case, three dimensions: exactly 1 work-type (bug/feature/refactor/docs/test/chore/perf), ≥1 cross-cutting concern, ≤2 tech tags. Check the vocabulary first: piyaz_get project view='meta'.",
    ),
  category: z
    .string()
    .max(LIMITS.category)
    .optional()
    .describe(
      "Exactly one project category (closed vocabulary; see piyaz_get project view='meta'). Do not coin new ones mid-task.",
    ),
  priority: z
    .enum(PRIORITY_ENUM)
    .optional()
    .describe(
      "urgent: cannot ship without; core: central to the release; normal: routine; backlog: deprioritized.",
    ),
  estimate: estimateSchema
    .optional()
    .describe(
      "Fibonacci story points (1/2/3/5/8/13). If a task feels >13, split it.",
    ),
  assigneeIds: z
    .array(
      z
        .string()
        .max(LIMITS.ref)
        .regex(ME_OR_UUID_RE, "each entry must be 'me' or a user UUID"),
    )
    .max(LIMITS.arrayItems)
    .optional()
    .describe(
      "'me' or team-member user UUIDs. Non-members are rejected. Declares ownership, not concurrent claim.",
    ),
  files: z
    .array(z.string().max(LIMITS.filePath))
    .max(LIMITS.files)
    .optional()
    .describe(
      "Repo-relative paths created or modified. Never invent paths; [] for work that touched no files.",
    ),
  implementationPlan: z
    .string()
    .max(LIMITS.plan)
    .optional()
    .describe(
      "Implementation plan (markdown, unabridged). Pair with status='planned'.",
    ),
  executionRecord: z
    .string()
    .max(LIMITS.executionRecord)
    .optional()
    .describe(
      "3-5 sentences on HOW it was built (file paths, function names). Only for tasks created already shipped or cancelled (rationale).",
    ),
  prUrl: z
    .url()
    .max(LIMITS.url)
    .optional()
    .describe(
      "PR URL; upserts a task_links row with kind derived from the URL.",
    ),
});

/** One edge in a `piyaz_create` batch. */
const createEdgeItemSchema = z.object({
  source: z
    .string()
    .max(LIMITS.ref)
    .describe("A `key` from this call, a taskRef ('PYZ-42'), or a task UUID."),
  target: z
    .string()
    .max(LIMITS.ref)
    .describe("A `key` from this call, a taskRef ('PYZ-42'), or a task UUID."),
  type: z
    .enum(["depends_on", "relates_to"])
    .describe(
      "depends_on = source needs target done first. relates_to = informational, neither blocks.",
    ),
  note: z
    .string()
    .max(LIMITS.edgeNote)
    .describe(
      "Why this relationship exists, as a brief to the developer starting the source task. REQUIRED; placeholders ('needed', 'depends', 'related') rejected.",
    ),
});

export const createInputSchema = z.object({
  project: projectRefParam.describe(
    "Project identifier ('PYZ') or project UUID. Required.",
  ),
  tasks: z
    .array(createTaskItemSchema)
    .min(1)
    .max(LIMITS.batchTasks)
    .describe("1-25 tasks to create in one atomic call."),
  edges: z
    .array(createEdgeItemSchema)
    .max(LIMITS.batchEdges)
    .optional()
    .describe(
      "Edges wiring the new tasks to each other (by key) and/or to existing tasks (by taskRef or UUID). Existing identical edges are silently skipped.",
    ),
  onDuplicate: z
    .enum(["skip", "error"])
    .optional()
    .describe(
      "skip (default): items whose exact title already exists in the project create nothing and return as 'deduped' (idempotent re-run). error: reject the whole batch before any write.",
    ),
});

/** One operation in a `piyaz_edit` call. Flat shape (no unions) for client
 * compatibility; the server validates coherence and returns per-op
 * corrective errors. */
const editOpSchema = z.object({
  op: z
    .enum([
      "str_replace",
      "append",
      "set",
      "add",
      "update",
      "remove",
      "check",
      "uncheck",
      "delete_task",
    ])
    .describe(
      "str_replace/append target a text field. set targets a text field or scalar field with value. add/update/remove/check/uncheck target a collection (by item id except add). delete_task must be the only op in the call.",
    ),
  field: z
    .enum([
      "description",
      "implementationPlan",
      "executionRecord",
      "status",
      "priority",
      "estimate",
      "category",
      "title",
      "tags",
      "files",
      "prUrl",
    ])
    .optional()
    .describe(
      "Target for text ops (description/implementationPlan/executionRecord) and scalar set (status/priority/estimate/category/title/tags/files/prUrl).",
    ),
  collection: z
    .enum(["acceptanceCriteria", "decisions", "links", "assignees"])
    .optional()
    .describe("Target collection for add/update/remove/check/uncheck."),
  oldStr: z
    .string()
    .max(LIMITS.plan)
    .optional()
    .describe(
      "str_replace only: exact existing text, must match exactly once. Copy it from piyaz_get fields=[...] including whitespace; on a multiple-match error include more surrounding context.",
    ),
  newStr: z
    .string()
    .max(LIMITS.plan)
    .optional()
    .describe("str_replace only: replacement text."),
  text: z
    .string()
    .max(LIMITS.plan)
    .optional()
    .describe(
      "append: paragraph to add. set on a text field: the full new text. add/update on acceptanceCriteria/decisions: the item text.",
    ),
  value: z
    .union([
      z.string().max(LIMITS.plan),
      z.number(),
      z.array(z.string().max(LIMITS.filePath)).max(LIMITS.files),
      z.null(),
    ])
    .optional()
    .describe(
      "set on a scalar field: the new value (tags/files take arrays; prUrl takes a URL or null to remove). add/remove on assignees: 'me' or a user UUID.",
    ),
  id: z
    .string()
    .max(LIMITS.ref)
    .optional()
    .describe(
      "Item id for update/remove/check/uncheck. Read ids via piyaz_get lens='working' or fields=['acceptanceCriteria', ...].",
    ),
  checked: z
    .boolean()
    .optional()
    .describe("add/update on acceptanceCriteria: the checked state."),
  url: z
    .string()
    .max(LIMITS.url)
    .optional()
    .describe(
      "add on links: the link URL (required). update on links: replacement URL; update patches only the supplied fields.",
    ),
  kind: z
    .string()
    .max(LIMITS.tag)
    .optional()
    .describe(
      "add/update on links: override the link kind (pull_request, issue, commit, doc, link); add defaults from the URL classifier, update keeps the stored kind unless supplied.",
    ),
  label: z
    .string()
    .max(LIMITS.title)
    .optional()
    .describe("add/update on links: display label."),
  preview: z
    .boolean()
    .optional()
    .describe(
      "delete_task only. true (default)=impact summary; false=execute. Prefer set status='cancelled' for abandoned scope; delete only noise (accidental, duplicate, contentless).",
    ),
});

export const editInputSchema = z.object({
  task: taskRefParam.describe("taskRef ('PYZ-42') or task UUID. Required."),
  ifUpdatedAt: z
    .string()
    .max(LIMITS.isoTimestamp)
    .optional()
    .describe(
      "Optimistic-concurrency precondition: the task's updatedAt from your last read (piyaz_get emits it). If the task changed since, the call fails with the current updatedAt — re-read, then retry. Use for contended tasks.",
    ),
  operations: z
    .array(editOpSchema)
    .min(1)
    .max(LIMITS.editOps)
    .describe(
      "1-20 operations applied in order, atomically: one failure rolls back all. delete_task must be the only op.",
    ),
});

export const linkInputSchema = z.object({
  action: z
    .enum(["create", "update", "remove"])
    .describe(
      "create=new edge (source, target, type, note required). update=rewrite the note of an edge keyed by source+target+type; with edgeId you may also change type. remove=delete by source+target+type or edgeId.",
    ),
  source: taskRefParam
    .optional()
    .describe(
      "Source taskRef ('PYZ-42') or UUID. Required for create; keys update/remove together with target+type.",
    ),
  target: taskRefParam
    .optional()
    .describe(
      "Target taskRef ('PYZ-42') or UUID. Required for create; keys update/remove together with source+type.",
    ),
  type: z
    .enum(["depends_on", "relates_to"])
    .optional()
    .describe(
      "depends_on = source needs target done first. relates_to = informational, neither blocks. Required for create.",
    ),
  note: z
    .string()
    .max(LIMITS.edgeNote)
    .optional()
    .describe(
      "Why this relationship exists; propagates into downstream agent context. REQUIRED on create; placeholders ('needed', 'depends', 'related') rejected. Write what the source task gets from the target: a decision, code, a contract, a fixture.",
    ),
  edgeId: z
    .uuid()
    .optional()
    .describe(
      "Edge UUID, when known. Alternative key for update/remove; source+target+type works without it.",
    ),
});

export const mapInputSchema = z.object({
  view: z
    .enum([
      "ready",
      "blocked",
      "plannable",
      "critical_path",
      "downstream",
      "neighbors",
    ])
    .describe(
      "ready=planned tasks with all effective deps done (drafts surface under plannable). blocked=waiting tasks with blocker details. plannable=drafts with description+criteria, ready for planning. critical_path=longest dependency chain (the bottleneck; lead with this on resume). downstream=transitive dependents of one task (impact analysis before changes). neighbors=1-2 hops around one task, both edge types and directions, with notes.",
    ),
  project: projectRefParam
    .optional()
    .describe(
      "Project identifier ('PYZ') or UUID. Required for ready/blocked/plannable/critical_path.",
    ),
  task: taskRefParam
    .optional()
    .describe("taskRef ('PYZ-42') or UUID. Required for downstream/neighbors."),
  hops: z
    .int()
    .min(1)
    .max(2)
    .optional()
    .describe("neighbors only: walk depth (default 1)."),
  limit: z
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Row cap (default 50). Truncation names the narrowing filter."),
});

export const activityInputSchema = z.object({
  project: projectRefParam
    .optional()
    .describe(
      "Project identifier ('PYZ') or UUID. Pass exactly one of project or task.",
    ),
  task: taskRefParam
    .optional()
    .describe(
      "taskRef ('PYZ-42') or UUID. Pass exactly one of project or task.",
    ),
  since: z
    .string()
    .max(LIMITS.isoTimestamp)
    .optional()
    .describe(
      "ISO timestamp lower bound (exclusive): only events after this instant. The resume primitive — pass the last moment you were caught up.",
    ),
  limit: z
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Page size, 1-50 (default 20)."),
  cursor: z
    .string()
    .max(LIMITS.cursor)
    .optional()
    .describe("Opaque cursor from a previous page's nextCursor."),
});

/** One tool's docs-relevant surface. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Name of the enum field that selects the tool's action/variant, or null
   * when the tool has a single shape (no Actions table in the docs). */
  discriminator: string | null;
}

/** All 8 tools in registration order. Titles match the MCP annotations. */
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "piyaz_workspace",
    title: "Workspace",
    description: DESCRIPTIONS.piyaz_workspace,
    inputSchema: workspaceInputSchema,
    discriminator: "action",
  },
  {
    name: "piyaz_search",
    title: "Search Tasks",
    description: DESCRIPTIONS.piyaz_search,
    inputSchema: searchInputSchema,
    discriminator: null,
  },
  {
    name: "piyaz_get",
    title: "Get Task or Project",
    description: DESCRIPTIONS.piyaz_get,
    inputSchema: getInputSchema,
    discriminator: "lens",
  },
  {
    name: "piyaz_create",
    title: "Create Tasks",
    description: DESCRIPTIONS.piyaz_create,
    inputSchema: createInputSchema,
    discriminator: null,
  },
  {
    name: "piyaz_edit",
    title: "Edit Task",
    description: DESCRIPTIONS.piyaz_edit,
    inputSchema: editInputSchema,
    discriminator: null,
  },
  {
    name: "piyaz_link",
    title: "Manage Edge",
    description: DESCRIPTIONS.piyaz_link,
    inputSchema: linkInputSchema,
    discriminator: "action",
  },
  {
    name: "piyaz_map",
    title: "Map Graph",
    description: DESCRIPTIONS.piyaz_map,
    inputSchema: mapInputSchema,
    discriminator: "view",
  },
  {
    name: "piyaz_activity",
    title: "Activity Feed",
    description: DESCRIPTIONS.piyaz_activity,
    inputSchema: activityInputSchema,
    discriminator: null,
  },
] as const;
