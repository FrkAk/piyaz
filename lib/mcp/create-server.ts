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
- Cross-team probes (an id you do not own) return 404-shaped. Only trust ids returned by list, teams, search, or context.

## Session start
1. \`mymir_project action='list'\`.
2. \`mymir_project action='teams'\` if \`list\` was empty or the user names a team it missed.
3. \`mymir_project action='select' projectId='...'\` to confirm. Pass \`projectId\` on every subsequent call.

## Find work
Lead with \`mymir_analyze\`. All variants are slim.
- \`critical_path\`: longest dependency chain, the project bottleneck. Most important for prioritization. Lead with this on continue / resume / "what should I work on".
- \`ready\`: tasks with all dependencies done. Pick from the intersection of \`ready\` and \`critical_path\`.
- \`plannable\`: draft tasks with description plus criteria, ready for planning when nothing is ready to code.
- \`blocked\`: tasks waiting on unfinished dependencies, with blocker detail.

\`mymir_query type='overview'\` is very heavy (every task, every edge, full tag vocab). Reserve it for unfamiliar projects or strategic review; do not run on routine status questions.

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
          .describe("list=projects across every team you belong to (skips empty teams). teams=every membership (id, name, slug, role, projectCount) — call before create or when list misses a team. create=new project (requires organizationId in multi-team accounts). select=confirm working project (returns projectId). update=modify fields."),
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
          .describe("Project prefix for task refs (e.g. 'MYM' yields MYM-1, MYM-2, …). 2-12 chars, uppercase alphanumeric, unique per team. Auto-derived from title on create when omitted. On update: renames every existing task ref — external references (PR titles, docs) no longer resolve."),
        organizationId: z.uuid().optional()
          .describe("Target team UUID for create. REQUIRED when you're a member of more than one team — the create is rejected with the team list inline otherwise. Auto-resolved when you belong to exactly one team. Membership is verified server-side; non-member targets return 'forbidden'."),
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
          return json({ selected: params.projectId, _hints: ["Stateless mode — pass this projectId explicitly on every subsequent call."] });
        }
        const { action, ...rest } = params;
        const result = await handleProject(
          { action: action as "list" | "teams" | "create" | "update", ...rest },
          ctx,
        );
        return toMcp(result);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "mymir_task",
    {
      description: DESCRIPTIONS.mymir_task,
      inputSchema: z.object({
        action: z.enum(["create", "update", "delete", "reorder"])
          .describe("create=new task. update=modify fields (pass only what changed). delete=remove (preview by default). reorder=change position."),
        taskId: z.uuid().optional()
          .describe("Task UUID. Required for update/delete/reorder."),
        projectId: z.uuid().optional()
          .describe("Project UUID. Required for create. Project's team scope is inherited."),
        title: z.string().optional()
          .describe("Verb+noun, short. Required for create (e.g. 'Implement JWT auth')."),
        description: z.string().optional()
          .describe("2-4 sentences: what to build, why it matters, key technical approach. Required for create."),
        status: z.enum(["draft", "planned", "in_progress", "done", "cancelled"]).optional()
          .describe("Lifecycle: draft → planned → in_progress → done. cancelled = terminal abandoned work; populate executionRecord with rationale. Cancelled deps are transparent — dependents stay blocked through the cancelled task's own unsatisfied deps. Excluded from progress and critical path."),
        acceptanceCriteria: z.array(
          z.union([
            z.string(),
            z.object({ id: z.string().optional(), text: z.string(), checked: z.boolean().optional() }),
          ]),
        ).optional()
          .describe("2-4 testable done conditions. Pass strings for new criteria, or objects with {text, checked} to set check state on existing rows."),
        decisions: z.array(z.string()).optional()
          .describe("Technical choices and constraints — one-liner per decision (CHOICE + WHY)."),
        tags: z.array(z.string()).optional()
          .describe("Kebab-case. Every task carries: exactly 1 work-type (bug/feature/refactor/docs/test/chore/perf), ≥1 cross-cutting concern (open: quality attribute or feature cluster), at most 2 tech tags (most important stack pieces touched), exactly 1 priority (release-blocker/core/normal/backlog). Do NOT tag codebase area (use category) or status. Run mymir_query type='overview' before coining new tags."),
        category: z.string().optional()
          .describe("Drawer group for this task. Should match a project category. Run mymir_project action='list' or mymir_query type='overview' to see available categories."),
        files: z.array(z.string()).optional()
          .describe("Every file path this task touches (relative to repo root)."),
        implementationPlan: z.string().optional()
          .describe("Implementation plan written during planning phase. Markdown."),
        executionRecord: z.string().optional()
          .describe("Summary of what was built during implementation. 3-5 sentences with concrete details (function names, file paths, endpoints). Markdown."),
        order: z.number().int().optional()
          .describe("0-based position. For create: initial order. For reorder: new position."),
        preview: z.boolean().optional().default(true)
          .describe("Delete only: true=show impact (default), false=actually delete."),
        overwriteArrays: z.boolean().optional().default(false)
          .describe("Update only: true=replace decisions/acceptanceCriteria/files entirely. Default false=append."),
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
        return err(e instanceof Error ? e.message : String(e));
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
          .describe("Why this relationship exists — propagates to agent context for downstream tasks. Strongly recommended on create."),
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
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "mymir_query",
    {
      description: DESCRIPTIONS.mymir_query,
      inputSchema: z.object({
        type: z.enum(["search", "list", "edges", "overview"])
          .describe("search=find tasks by taskRef, title, or tag (case-insensitive, up to 20). list=all tasks ordered by position. edges=relationships on a task. overview=full project structure with progress + tag vocab."),
        query: z.string().optional()
          .describe("Search string for type='search'. Matches taskRef, title substring, or tag substring. Optional when `tags` is provided."),
        tags: z.array(z.string()).optional()
          .describe("Filter to tasks containing ANY of these exact tags (OR-within). Combine with `query` to narrow further. Pick from the Tag vocabulary in `type='overview'`."),
        taskId: z.uuid().optional()
          .describe("Task UUID for type='edges'."),
        projectId: z.uuid().optional()
          .describe("Project UUID. Required for search/list/overview."),
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
        return err(e instanceof Error ? e.message : String(e));
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
          .describe("summary=quick (status, edge counts). working=detailed (criteria, decisions, 1-hop edges, siblings). agent=multi-hop deps + execution records (use BEFORE coding). planning=spec for pre-implementation (project description, prereqs, acceptance criteria, downstream specs)."),
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
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "mymir_analyze",
    {
      description: DESCRIPTIONS.mymir_analyze,
      inputSchema: z.object({
        type: z.enum(["ready", "blocked", "downstream", "critical_path", "plannable"])
          .describe("ready=unblocked work to start. blocked=waiting tasks with blocker details. downstream=transitive dependents (impact analysis before changes). critical_path=longest dep chain (project bottleneck). plannable=draft tasks with description+criteria, ready for planning."),
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
        return err(e instanceof Error ? e.message : String(e));
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
