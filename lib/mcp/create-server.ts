import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  DESCRIPTIONS,
  handleProject,
  handleTask,
  handleEdge,
  handleQuery,
  handleContext,
  handleAnalyze,
} from "@/lib/graph/tool-handlers";
import type { ToolResult } from "@/lib/graph/tool-handlers";
import { identifierSchema } from "@/lib/graph/identifier";
import type { AuthContext } from "@/lib/auth/context";

/**
 * Format a successful tool result as MCP content.
 * @param data - Result data from a tool handler.
 * @returns MCP content response.
 */
function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

/**
 * Format an error as MCP content.
 * @param message - Error message.
 * @returns MCP error response.
 */
function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/**
 * Sanitised MCP error emitter for tool catch blocks. Mirrors the frontend
 * `internalError` helper in `lib/api/error.ts`: logs the original error
 * server-side with a tool-scoped label so failures stay debuggable, but
 * returns an opaque `Internal error` body so untrusted callers can't read
 * driver-level SQL fragments, bound parameters, or schema names that show
 * up in a raw Postgres exception.
 *
 * Domain errors thrown deliberately by handlers should reach the client
 * via the `ToolResult.ok = false` path through `toMcp`, not through this
 * catch. This helper exists to neutralise unexpected throws (e.g. a unique
 * constraint violation that bubbles up from Drizzle without a wrapper).
 *
 * Verbose mode is whitelist-gated to `NODE_ENV === "development"` (i.e.
 * `bun run dev`). Production, test, staging, undefined, typos, future
 * Next.js renames all fall through to the generic body. Fail-safe by
 * default: a silent env-var change can never start leaking SQL fragments,
 * bound parameters, or stack traces to MCP clients.
 *
 * @param label - Tool name (e.g. `"mymir_project"`).
 * @param e - The thrown error.
 * @returns MCP error response.
 */
function mcpError(label: string, e: unknown) {
  console.error(`[mcp:${label}] error:`, e);
  const verbose = process.env.NODE_ENV === "development";
  const message = verbose && e instanceof Error ? e.message : "Internal error";
  return err(message);
}

/**
 * Convert a ToolResult to MCP response format.
 * Handles string results (context depths) as raw text.
 * @param result - Tool handler result.
 * @returns MCP content response.
 */
function toMcp(result: ToolResult) {
  if (!result.ok) return err(result.error);
  if (typeof result.data === "string") {
    return { content: [{ type: "text" as const, text: result.data }] };
  }
  return json(result.data);
}

const INSTRUCTIONS = `Mymir is an agentic project management server for software projects. It tracks tasks, dependencies, decisions, and execution records across sessions and teammates so coding agents and engineers can hand work to each other. Stateless HTTP endpoint with no server-side session state; pass \`projectId\` explicitly on every call.

This file documents the canonical flows the skill expects the server to cover: session start, find work, implement, plan, refine, the Completion Protocol, and propagation. Everything else, including persona, the four-dimension tag taxonomy, the category vocabulary by project type, the full per-status lifecycle table, the dispatch / decompose / onboarding / brainstorm / manage agents, parallel-agent orchestration, and the resume-after-compaction pattern, lives in the \`mymir\` skill on your platform (Claude Code, Codex, Cursor, Gemini) and its references (\`conventions.md\`, \`artifacts.md\`, \`lifecycle.md\`, \`resilience.md\`). The skill is the ground truth.

## Multi-team awareness
The caller's account spans every membership. There is no 'active' team. Read tools span every team you belong to; writes name \`organizationId\` or auto-resolve when the account has exactly one membership.
- \`mymir_project action='list'\`: projects with team metadata. Skips teams with zero projects, so pair with \`teams\` for the full set.
- \`mymir_project action='teams'\`: every membership (id, name, slug, role, projectCount). Includes empty teams. Run before \`create\`, when \`list\` is empty, or when the user names a team \`list\` did not surface.
- Out-of-team probes (an id from a team you do not belong to) return 404-shaped. Within-team-other-project reads succeed by design; every team member can read all projects in their teams. Only trust ids returned by list, teams, search, or context.

## Session start
1. \`mymir_project action='list'\`.
2. \`mymir_project action='teams'\` if \`list\` was empty or the user names a team it missed.
3. \`mymir_project action='select' projectId='...'\` to confirm. Pass \`projectId\` on every subsequent call.

## Find work
Lead with \`mymir_analyze\` (all variants slim):
- \`critical_path\` first on continue / resume / "what's next"; the bottleneck dictates priority.
- \`ready\` for unblocked planned tasks (drafts with satisfied deps surface as \`plannable\`, not \`ready\`); pick from \`ready ∩ critical_path\` for the highest-impact unblocked work.
- \`plannable\` when nothing is ready to code (drafts with description + criteria + deps satisfied).
- \`blocked\` to diagnose what's stuck (waiting tasks with blocker detail).
- \`downstream\` for impact analysis before a status change, refinement, or cancellation; not for picking next work.

Drop to \`mymir_query\` for browse / lookup:
- \`search\` (slim): find a task by taskRef, title fragment, or tag substring; \`tags=[...]\` for exact-tag OR-filter; single-result responses carry a state hint pointing at the right next call.
- \`list\` (medium): every task in the project, slim per-task fields, ordered by position.
- \`edges\` (slim): one task's relationships (connected ref, title, status, direction, note).
- \`meta\` (slim): the project's categories, tag vocabulary with usage counts, description, status, and progress. Use before setting a \`category\` or coining new tags; lighter than overview.
- \`overview\` (very heavy): full structure (every task, every edge, full tag vocab, progress). Reserve for unfamiliar-project orientation, decompose's pre-write coverage check, or strategic review. At most once per session. Do not run on routine status questions.

## Refine a task
1. \`mymir_context taskId='...' depth='working'\` for current state, edges, siblings.
2. Before proposing changes, explore. Search related tasks (\`mymir_query type='search'\` by tag or title fragment), read current docs for any framework or library the task touches, check the actual codebase for what already exists. No speculation. If you don't know, look; if you can't find it, ask. Refining on assumptions is how vague tasks survive review.
3. Improve description, acceptance criteria, decisions, dependencies. Push back on vagueness; rewrite single-sentence descriptions and "works correctly" ACs before saving.
4. \`mymir_task action='update'\`. The default appends to array fields; \`overwriteArrays=true\` REPLACES them and is destructive. Confirm with the user before using it.
5. Propagate per the Propagate section if decisions changed.

## Implement a task
0. If the task is \`draft\`, plan it first (see Plan a draft task).
1. Claim. \`mymir_task action='update' status='in_progress'\`. Prevents two agents grabbing the same task.
2. Context. \`mymir_context taskId='...' depth='agent'\`. Multi-hop dependencies, upstream execution records, acceptance criteria.
3. Understand before doing. Read the description, the executionRecords from upstream tasks, and the relevant code. Reason about what could go wrong. Ask if anything is unclear. Then implement. Rushing here produces work that misses the actual requirement.
4. Build the work.
5. Mark done via the Completion Protocol below. The \`done\` update carries:
   - \`executionRecord\`: 3 to 5 sentences with concrete file paths, function names, endpoints. Description is scope; executionRecord is HOW it was built.
   - \`decisions\`: one line per technical choice. Format: CHOICE plus WHY.
   - \`files\`: every path created or modified.
   - \`acceptanceCriteria\`: pass each item as \`{text, checked: true|false}\`. Evaluate against the work; do not auto-check everything.
   Do not pass \`overwriteArrays=true\` unless replacing the arrays is the intent and the user has confirmed.
6. Propagate per the Propagate section.

## Plan a draft task
1. \`mymir_context taskId='...' depth='planning'\` for project description, prerequisites, downstream specs.
2. Write the implementation plan. Search the codebase for what already exists, read up-to-date docs for any new dependency, clarify open questions with the user, reason through edge cases. File paths, line numbers, specific changes, verification steps. No speculation.
3. \`mymir_task action='update' implementationPlan='<full markdown>' status='planned'\`. Save the complete unabridged plan. Do not summarize.

## Completion Protocol
Run before transitioning a task to \`done\` or \`cancelled\`.

1. Detect mode by transcript.
   - Dispatched: your context shows a parent agent invoked you. Mark done directly with the full payload and return a one-sentence summary to the parent. Do not ask.
   - Direct: invoked by the user in a normal session. Ask "Ready to mark this done?" with a one-sentence \`executionRecord\` preview. Wait for explicit confirmation.
   - Uncertain: default to asking. A spurious confirmation is cheap; an unauthorized status change is expensive.

2. Populate required fields. \`executionRecord\`, \`decisions\`, \`files\`, \`acceptanceCriteria\`. The server returns \`_hints\` for any missing fields; re-call with the additions before continuing. For \`cancelled\`: \`executionRecord\` carries the rationale (why abandoned, what was tried) and \`decisions\` records anything learned.

3. Open a PR if the work changed code. Detect a template at \`.github/PULL_REQUEST_TEMPLATE.md\`, \`.github/pull_request_template.md\`, \`.github/PULL_REQUEST_TEMPLATE/<name>.md\`, or \`docs/pull_request_template.md\`. If a template exists, fill it; map task fields onto template sections only where they fit, and leave a section blank rather than invent content. Common mappings:
   - Linked issue / linked task: include the \`taskRef\` in \`[BRACKETS]\` (e.g. \`[MYMR-83]\`). Bracket form triggers Mymir PR-status tracking; use it for the ONE primary task this PR builds. Reference related tasks elsewhere as plain links (no brackets). Add \`Closes #N\` on its own line if a GitHub issue is being resolved.
   - Summary: 2 to 3 sentences from \`executionRecord\`.
   - Test plan / verification: the checked \`acceptanceCriteria\` items.
   - Decisions or notes-for-reviewer: relevant entries from \`decisions\`.
   If no template exists, use a concise default with Summary (containing the bracketed task reference and an optional \`Closes #N\` line), Type of change, Testing, and Notes for reviewer. Always concise; empty optional sections beat fabricated content.

4. Skip the PR for these task types: research / investigation (no code change), decision-only, pure-Mymir refinement (no repo changes), tasks the user explicitly said "no PR" on. When in doubt, ask before opening.

## Propagate after every change
After any status change or significant refinement:
1. \`mymir_query type='edges'\` on the changed task to see current relationships.
2. \`mymir_analyze type='downstream'\` to enumerate dependents.
3. For each downstream task evaluate: do edge notes need updating to reflect new decisions; are there NEW relationships revealed by this change; are there STALE relationships that no longer hold; do downstream descriptions need updating based on the decisions made.
4. Create, update, or remove edges as needed.

For cancellations: edges to a cancelled task remain in place because cancellation is transitive-aware (dependents stay blocked through the cancelled task's own unsatisfied prereqs). Ask whether there is a replacement. If yes, rewire dependents to the replacement. If no, dependents may need to be cancelled too or re-scoped to no longer require the cancelled work.

Skipping propagation is how dependency graphs go stale. Stale graphs make Mymir useless.

## Tool descriptions and \`_hints\` are runtime instructions
Every tool injects two things into your context: the parameter schema before the call, and a \`_hints\` array in the response. These are not optional commentary. They are server-side rules and state you cannot see otherwise, and they override any prior plan you had. Read on every tool call; act on them before continuing. Skipping a hint is operating on stale information. Errors are token dense and self correcting; the message often names the next call with the team or task list inline. Re-read errors and act on them before falling back to asking the user.

## Iron Law of grounding
Never write what you cannot cite or do not know. Applies wherever an agent generates \`executionRecord\`, \`decisions\`, \`description\`, or \`files\`. When uncertain, write less; a short true record is more valuable than a rich fabricated one. The full quality bar for titles, descriptions, ACs, tag dimensions, categories, edge notes, and markdown tone lives in the skill's \`artifacts.md\`.

## Mutation safety
Update array fields (\`decisions\`, \`acceptanceCriteria\`, \`files\`) APPEND by default. Pass \`overwriteArrays=true\` only when replacing is the intent and the user has confirmed. \`mymir_task action='delete'\` defaults to \`preview=true\`; show impact, get explicit confirmation, then \`preview=false\`. For abandoned scope prefer \`status='cancelled'\` with rationale in \`executionRecord\` over deletion; edges to cancelled tasks remain in place and cancellation is transitive-aware.

## Remote mode
This is a stateless HTTP endpoint. No session state is persisted server-side. The \`select\` action on \`mymir_project\` returns a confirmation but does not set server state. Always pass \`projectId\` explicitly on every subsequent call.`;

/**
 * Register all 6 Mymir tools on a server instance, bound to the caller's
 * auth context. Each tool handler receives `ctx` as its second arg so
 * authorization and team scoping happen inside the data layer.
 * @param server - Any object with a registerTool method (McpServer or mock).
 * @param ctx - Resolved auth context (user id only — team scope per call).
 */
export function registerAllTools(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    "mymir_project",
    {
      description: DESCRIPTIONS.mymir_project,
      inputSchema: z.object({
        action: z.enum(["list", "teams", "create", "select", "update"])
          .describe("list=projects across every team you belong to (id, title, identifier, status, team chip, task counts, progress); skips empty teams; description and tag vocab fetched on demand via mymir_query type='meta'. teams=every membership (id, name, slug, role, projectCount); call before create or when list misses a team. create=new project (requires organizationId in multi-team accounts). select=confirm working project (returns projectId). update=modify fields."),
        projectId: z.uuid().optional()
          .describe("Project UUID. Required for select and update."),
        title: z.string().optional()
          .describe("Project name (2-5 words, verb-noun preferred). Required for create."),
        description: z.string().optional()
          .describe("3-5 sentence brief: problem, user, features, tech direction, constraints."),
        status: z.enum(["brainstorming", "decomposing", "active", "archived"]).optional()
          .describe("Lifecycle: brainstorming → decomposing → active → archived. Settable on create (defaults to 'brainstorming') or update."),
        categories: z.array(z.string()).optional()
          .describe("Task categories for this project (e.g. ['backend', 'frontend', 'mcp']). Drives drawer grouping in the UI."),
        identifier: identifierSchema.optional()
          .describe("Project prefix for task refs (e.g. 'MYM' yields MYM-1, MYM-2, ...). 2-12 chars, uppercase alphanumeric, unique per team. Auto-derived from title on create when omitted. On update: renames every existing task ref; external references (PR titles, docs) no longer resolve."),
        organizationId: z.uuid().optional()
          .describe("Target team UUID for create. REQUIRED when you're a member of more than one team; the create is rejected with the team list inline otherwise. Auto-resolved when you belong to exactly one team. Membership is verified server-side; non-member targets return 'forbidden'."),
      }),
      annotations: {
        title: "Manage Project",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        if (params.action === "select") {
          if (!params.projectId) return err("projectId required for select. Call mymir_project action='list' first to enumerate your projects.");
          return json({ selected: params.projectId, _hints: ["Stateless mode. Pass this projectId explicitly on every subsequent call."] });
        }
        const { action, ...rest } = params;
        const result = await handleProject(
          { action: action as "list" | "teams" | "create" | "update", ...rest },
          ctx,
        );
        return toMcp(result);
      } catch (e) {
        return mcpError("mymir_project", e);
      }
    },
  );

  server.registerTool(
    "mymir_task",
    {
      description: DESCRIPTIONS.mymir_task,
      inputSchema: z.object({
        action: z.enum(["create", "update", "delete"])
          .describe("create=new task. update=modify fields (pass only what changed). delete=remove (preview by default)."),
        taskId: z.uuid().optional()
          .describe("Task UUID (not the 'MYM-N' taskRef; refs are display-only). Required for update/delete."),
        projectId: z.uuid().optional()
          .describe("Project UUID. Required for create. Project's team scope is inherited."),
        title: z.string().optional()
          .describe("Verb+noun, imperative. Required for create (e.g. 'Implement JWT auth', not 'Auth'). Artifacts §1."),
        description: z.string().optional()
          .describe("2-4 sentences (up to 6-8 for genuinely complex tasks; single-sentence rejected): what + who it serves + where it fits in the architecture. Required for create. Artifacts §1."),
        status: z.enum(["draft", "planned", "in_progress", "done", "cancelled"]).optional()
          .describe("Lifecycle: draft → planned → in_progress → done. cancelled = terminal abandoned work; populate executionRecord with rationale. Cancelled deps are transparent: dependents stay blocked through the cancelled task's own unsatisfied deps. Excluded from progress and critical path."),
        acceptanceCriteria: z.array(
          z.union([
            z.string(),
            z.object({ id: z.string().optional(), text: z.string(), checked: z.boolean().optional() }),
          ]),
        ).optional()
          .describe("2-4 binary items (reviewer answers YES/NO; single-AC and vague ACs like 'works correctly' rejected). Pass strings for new criteria, or {text, checked} objects to evaluate existing rows. Artifacts §1."),
        decisions: z.array(z.string()).optional()
          .describe("Technical choices and constraints. One-liner per decision (CHOICE + WHY)."),
        tags: z.array(z.string()).optional()
          .describe("Kebab-case. Every task carries: exactly 1 work-type (bug/feature/refactor/docs/test/chore/perf), ≥1 cross-cutting concern (open: quality attribute or feature cluster), at most 2 tech tags (most important stack pieces touched), exactly 1 priority (release-blocker/core/normal/backlog). Do NOT tag codebase area (use category) or status. Run mymir_query type='meta' before coining new tags."),
        category: z.string().optional()
          .describe("Architectural layer / subsystem this task belongs to (exactly one). Reuse a project category; do not silently coin mid-task. The project's 4-8 categories are set on creation or via decompose/onboarding gates. Run mymir_query type='meta' to see them. Artifacts §4."),
        files: z.array(z.string()).optional()
          .describe("Repo-relative paths created or modified (no leading slash, no absolute). Pass `files=[]` when nothing was touched (unscaffolded repo, research/spec-review/decision-only); never invent paths."),
        implementationPlan: z.string().optional()
          .describe("Implementation plan (markdown, unabridged; do not summarize). Pass with `status='planned'` to transition draft → planned; without the status change the task stays incomplete (lifecycle §1)."),
        executionRecord: z.string().optional()
          .describe("3-5 sentences on HOW it was built (function names, file paths, endpoints; distinct from description=scope). For cancelled: rationale + what was tried instead. Draft tasks must not carry this. Iron Law: cite real code, omit what you cannot. Markdown. Artifacts §1."),
        preview: z.boolean().optional().default(true)
          .describe("Delete only: true=show impact (default), false=actually delete."),
        overwriteArrays: z.boolean().optional().default(false)
          .describe("Update only. true=replace decisions/acceptanceCriteria/files; default false=append. Destructive, NO undo; confirm with user first."),
      }),
      annotations: {
        title: "Manage Task",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const result = await handleTask(params, ctx);
        return toMcp(result);
      } catch (e) {
        return mcpError("mymir_task", e);
      }
    },
  );

  server.registerTool(
    "mymir_edge",
    {
      description: DESCRIPTIONS.mymir_edge,
      inputSchema: z.object({
        action: z.enum(["create", "update", "remove"])
          .describe("create=new edge. update=modify type or note. remove=delete by edgeId or by source+target+type."),
        edgeId: z.uuid().optional()
          .describe("Edge UUID. Required for update. For remove: use this OR sourceTaskId+targetTaskId+edgeType."),
        sourceTaskId: z.uuid().optional()
          .describe("Source task UUID. Required for create. Alternative key for remove."),
        targetTaskId: z.uuid().optional()
          .describe("Target task UUID. Required for create. Alternative key for remove."),
        edgeType: z.enum(["depends_on", "relates_to"]).optional()
          .describe("depends_on = source needs target done first. relates_to = informational link, neither blocks the other. Required for create."),
        note: z.string().optional()
          .describe("Why this relationship exists. Propagates to agent context for downstream tasks, so write it as a brief to the developer about to start the source task: what specifically does this task get from the target? REQUIRED on create; placeholders ('needed', 'depends', 'related') are rejected."),
      }),
      annotations: {
        title: "Manage Edge",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const result = await handleEdge(params, ctx);
        return toMcp(result);
      } catch (e) {
        return mcpError("mymir_edge", e);
      }
    },
  );

  server.registerTool(
    "mymir_query",
    {
      description: DESCRIPTIONS.mymir_query,
      inputSchema: z.object({
        type: z.enum(["search", "list", "edges", "meta", "overview"])
          .describe("search=find tasks by taskRef, title, or tag (case-insensitive, up to 20). list=all tasks ordered by position. edges=relationships on a task. meta=slim project metadata (header, categories, tag vocab with counts, progress); use to look up categories or tag vocab without overview. overview=full project structure with progress + tag vocab + every task + every edge."),
        query: z.string().optional()
          .describe("Search string for type='search'. Matches taskRef, title substring, or tag substring. Optional when `tags` is provided."),
        tags: z.array(z.string()).optional()
          .describe("Filter to tasks containing ANY of these exact tags (OR-within). Combine with `query` to narrow further. Pick from the tag vocabulary in `type='meta'`."),
        taskId: z.uuid().optional()
          .describe("Task UUID for type='edges'."),
        projectId: z.uuid().optional()
          .describe("Project UUID. Required for search/list/meta/overview."),
      }),
      annotations: {
        title: "Query Tasks",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const result = await handleQuery(params, ctx);
        return toMcp(result);
      } catch (e) {
        return mcpError("mymir_query", e);
      }
    },
  );

  server.registerTool(
    "mymir_context",
    {
      description: DESCRIPTIONS.mymir_context,
      inputSchema: z.object({
        taskId: z.uuid().describe("Task UUID."),
        depth: z.enum(["summary", "working", "agent", "planning"]).default("working")
          .describe("summary=task header + description + counts + 1-hop edges with notes (folds in `mymir_query type='edges'`). working=criteria, decisions, 1-hop edges, siblings (does NOT render executionRecord, files, or implementationPlan). agent=multi-hop deps + upstream execution records + files + downstream; renders the task's own executionRecord when status is done/cancelled (use BEFORE coding, and to read a finished task's record). planning=project description, prereqs, ACs, downstream specs (use BEFORE writing the implementation plan)."),
        projectId: z.uuid().optional()
          .describe("Project UUID. Required for 'working' depth."),
      }),
      annotations: {
        title: "Get Task Context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const result = await handleContext(params, ctx);
        return toMcp(result);
      } catch (e) {
        return mcpError("mymir_context", e);
      }
    },
  );

  server.registerTool(
    "mymir_analyze",
    {
      description: DESCRIPTIONS.mymir_analyze,
      inputSchema: z.object({
        type: z.enum(["ready", "blocked", "downstream", "critical_path", "plannable"])
          .describe("ready=planned tasks with all deps done (drafts with deps satisfied surface as plannable, not ready). blocked=waiting tasks with blocker details. downstream=transitive dependents (impact analysis before changes). critical_path=longest dep chain (project bottleneck). plannable=draft tasks with description+criteria, ready for planning."),
        taskId: z.uuid().optional()
          .describe("Task UUID. Required for 'downstream'."),
        projectId: z.uuid().optional()
          .describe("Project UUID. Required for ready/blocked/critical_path/plannable."),
      }),
      annotations: {
        title: "Analyze Graph",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const result = await handleAnalyze(params, ctx);
        return toMcp(result);
      } catch (e) {
        return mcpError("mymir_analyze", e);
      }
    },
  );

}

/**
 * Create a stateless MCP server bound to the caller's auth context.
 *
 * Read tools (`list`, queries, context) span every team the caller is a
 * member of. Writes either name an explicit `organizationId` (membership-
 * checked) or auto-resolve when the caller belongs to exactly one team.
 * Multi-team callers must pass `organizationId` on `mymir_project create`;
 * the server returns a hard error with the team list inline otherwise.
 *
 * @param ctx - Resolved auth context derived from the OAuth JWT.
 * @returns Configured McpServer instance.
 */
export function createMcpServer(ctx: AuthContext): McpServer {
  const server = new McpServer(
    { name: "mymir", version: "1.5.0" },
    { instructions: INSTRUCTIONS },
  );
  registerAllTools(server, ctx);
  return server;
}
