import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  handleProject,
  handleTask,
  handleEdge,
  handleQuery,
  handleContext,
  handleAnalyze,
} from "@/lib/graph/tool-handlers";
import type { ToolResult } from "@/lib/graph/tool-handlers";
import {
  DESCRIPTIONS,
  projectInputSchema,
  taskInputSchema,
  edgeInputSchema,
  queryInputSchema,
  contextInputSchema,
  analyzeInputSchema,
} from "@/lib/mcp/schemas";
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
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
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
 * @param label - Tool name (e.g. `"piyaz_project"`).
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

const INSTRUCTIONS = `Piyaz is an agentic project management server for software projects. It tracks tasks, dependencies, decisions, and execution records across sessions and teammates so coding agents and engineers can hand work to each other. Stateless HTTP endpoint with no server-side session state; pass \`projectId\` explicitly on every call.

This file documents the canonical flows the skill expects the server to cover: session start, find work, implement, plan, refine, the Completion Protocol, and propagation. Everything else, including persona, the three-dimension tag taxonomy plus the first-class \`priority\` / \`estimate\` / \`assigneeIds\` fields, the category vocabulary by project type, the full per-status lifecycle table, the dispatch / decompose / onboarding / brainstorm / manage agents, parallel-agent orchestration, and the resume-after-compaction pattern, lives in the \`piyaz\` skill on your platform (Claude Code, Codex, Cursor, Antigravity) and its references (\`conventions.md\`, \`artifacts.md\`, \`lifecycle.md\`, \`resilience.md\`). The skill is the ground truth.

## Multi-team awareness
The caller's account spans every membership. There is no 'active' team. Read tools span every team you belong to; writes name \`organizationId\` or auto-resolve when the account has exactly one membership.
- \`piyaz_project action='list'\`: projects with team metadata. Skips teams with zero projects, so pair with \`teams\` for the full set.
- \`piyaz_project action='teams'\`: every membership (id, name, slug, role, projectCount). Includes empty teams. Run before \`create\`, when \`list\` is empty, or when the user names a team \`list\` did not surface.
- Out-of-team probes (an id from a team you do not belong to) return 404-shaped. Within-team-other-project reads succeed by design; every team member can read all projects in their teams. Only trust ids returned by list, teams, search, or context.

## Session start
1. \`piyaz_project action='list'\`.
2. \`piyaz_project action='teams'\` if \`list\` was empty or the user names a team it missed.
3. \`piyaz_project action='select' projectId='...'\` to confirm. Pass \`projectId\` on every subsequent call.

## Find work
Lead with \`piyaz_analyze\` (all variants slim):
- \`critical_path\` first on continue / resume / "what's next"; the bottleneck dictates priority.
- \`ready\` for unblocked planned tasks (drafts with satisfied deps surface as \`plannable\`, not \`ready\`); pick from \`ready ∩ critical_path\` for the highest-impact unblocked work.
- \`plannable\` when nothing is ready to code (drafts with description + criteria + deps satisfied).
- \`blocked\` to diagnose what's stuck (waiting tasks with blocker detail).
- \`downstream\` for impact analysis before a status change, refinement, or cancellation; not for picking next work.

Drop to \`piyaz_query\` for browse / lookup:
- \`search\` (slim): find a task by taskRef, title fragment, or tag substring; \`tags=[...]\` for exact-tag OR-filter; single-result responses carry a state hint pointing at the right next call.
- \`list\` (medium): every task in the project, slim per-task fields, ordered by position.
- \`edges\` (slim): one task's relationships (connected ref, title, status, direction, note).
- \`meta\` (slim): the project's categories, tag vocabulary with usage counts, description, status, and progress. Use before setting a \`category\` or coining new tags; lighter than overview.
- \`overview\` (very heavy): full structure (every task, every edge, full tag vocab, progress). Reserve for unfamiliar-project orientation, decompose's pre-write coverage check, or strategic review. At most once per session. Do not run on routine status questions.

## Refine a task
1. \`piyaz_context taskId='...' depth='working'\` for current state and 1-hop edges.
2. Before proposing changes, explore. Search related tasks (\`piyaz_query type='search'\` by tag or title fragment), read current docs for any framework or library the task touches, check the actual codebase for what already exists. No speculation. If you don't know, look; if you can't find it, ask. Refining on assumptions is how vague tasks survive review.
3. Improve description, acceptance criteria, decisions, dependencies. Push back on vagueness; rewrite single-sentence descriptions and "works correctly" ACs before saving.
4. \`piyaz_task action='update'\`. The default appends to array fields; \`overwriteArrays=true\` REPLACES them and is destructive. Confirm with the user before using it.
5. Propagate per the Propagate section if decisions changed.

## Implement a task
0. If the task is \`draft\`, plan it first (see Plan a draft task).
1. Claim. \`piyaz_task action='update' status='in_progress'\`. Prevents two agents grabbing the same task.
2. Context. \`piyaz_context taskId='...' depth='agent'\`. Multi-hop dependencies, upstream execution records, acceptance criteria.
3. Understand before doing. Read the description, the executionRecords from upstream tasks, and the relevant code. Reason about what could go wrong. Ask if anything is unclear. Then implement. Rushing here produces work that misses the actual requirement.
4. Build the work.
5. Mark in_review via the Completion Protocol below. The \`in_review\` update carries:
   - \`executionRecord\`: 3 to 5 sentences with concrete file paths, function names, endpoints. Description is scope; executionRecord is HOW it was built.
   - \`decisions\`: one line per technical choice. Format: CHOICE plus WHY.
   - \`files\`: every path created or modified.
   - \`acceptanceCriteria\`: pass each item as \`{text, checked: true|false}\`. Evaluate against the work; do not auto-check everything.
   - \`prUrl\`: the PR URL the implementer just opened (optional sugar; backend upserts a \`task_links\` row with kind='pull_request' so the review subagent and detail UI can read it). Omit when no PR was opened.
   Do not pass \`overwriteArrays=true\` unless replacing the arrays is the intent and the user has confirmed.
   The HOTL gate flips \`in_review → done\` after PR approval/merge. Agents must not self-promote to \`done\`.
6. Propagate per the Propagate section.

## Plan a draft task
1. \`piyaz_context taskId='...' depth='planning'\` for project description, prerequisites, downstream specs.
2. Write the implementation plan. Search the codebase for what already exists, read up-to-date docs for any new dependency, clarify open questions with the user, reason through edge cases. File paths, line numbers, specific changes, verification steps. No speculation.
3. \`piyaz_task action='update' implementationPlan='<full markdown>' status='planned'\`. Save the complete unabridged plan. Do not summarize.

## Completion Protocol
Run before transitioning a task to \`in_review\`, \`done\`, or \`cancelled\`. The implementer phase terminates at \`in_review\` with the full payload; \`done\` is reserved for the HOTL operator after PR approval (no extra fields required, transition only).

1. Detect mode by transcript.
   - Dispatched: your context shows a parent agent invoked you. Mark \`in_review\` directly with the full payload (the implementer's terminal write); the HOTL operator finalizes to \`done\`. Return a one-sentence summary to the parent. Do not ask.
   - Direct: invoked by the user in a normal session. Ask "Ready to mark this \`in_review\`?" with a one-sentence \`executionRecord\` preview. Wait for explicit confirmation; the HOTL operator finalizes to \`done\` after PR approval.
   - Uncertain: default to asking. A spurious confirmation is cheap; an unauthorized status change is expensive.

2. Populate required fields. \`executionRecord\`, \`decisions\`, \`files\`, \`acceptanceCriteria\`, and \`prUrl\` when a PR was opened (backend upserts a \`task_links\` row with kind='pull_request'). The server returns \`_hints\` for any missing fields; re-call with the additions before continuing. For \`cancelled\`: \`executionRecord\` carries the rationale (why abandoned, what was tried) and \`decisions\` records anything learned.

3. Open a PR if the work changed code. Detect a template at \`.github/PULL_REQUEST_TEMPLATE.md\`, \`.github/pull_request_template.md\`, \`.github/PULL_REQUEST_TEMPLATE/<name>.md\`, or \`docs/pull_request_template.md\`. If a template exists, fill it; map task fields onto template sections only where they fit, and leave a section blank rather than invent content. Common mappings:
   - Linked issue / linked task: include the \`taskRef\` in \`[BRACKETS]\` (e.g. \`[MYMR-83]\`). Bracket form triggers Piyaz PR-status tracking; use it for the ONE primary task this PR builds. Reference related tasks elsewhere as plain links (no brackets). Add \`Closes #N\` on its own line if a GitHub issue is being resolved.
   - Summary: 2 to 3 sentences from \`executionRecord\`.
   - Test plan / verification: the checked \`acceptanceCriteria\` items.
   - Decisions or notes-for-reviewer: relevant entries from \`decisions\`.
   If no template exists, use a concise default with Summary (containing the bracketed task reference and an optional \`Closes #N\` line), Type of change, Testing, and Notes for reviewer. Always concise; empty optional sections beat fabricated content.

4. Skip the PR for these task types: research / investigation (no code change), decision-only, pure-Piyaz refinement (no repo changes), tasks the user explicitly said "no PR" on. When in doubt, ask before opening.

## Propagate after every change
After any status change or significant refinement:
1. \`piyaz_query type='edges'\` on the changed task to see current relationships.
2. \`piyaz_analyze type='downstream'\` to enumerate dependents.
3. For each downstream task evaluate: do edge notes need updating to reflect new decisions; are there NEW relationships revealed by this change; are there STALE relationships that no longer hold; do downstream descriptions need updating based on the decisions made.
4. Create, update, or remove edges as needed.

For cancellations: edges to a cancelled task remain in place because cancellation is transitive-aware (dependents stay blocked through the cancelled task's own unsatisfied prereqs). Ask whether there is a replacement. If yes, rewire dependents to the replacement. If no, dependents may need to be cancelled too or re-scoped to no longer require the cancelled work.

Skipping propagation is how dependency graphs go stale. Stale graphs make Piyaz useless.

## Tool descriptions and \`_hints\` are runtime instructions
Every tool injects two things into your context: the parameter schema before the call, and a \`_hints\` array in the response. These are not optional commentary. They are server-side rules and state you cannot see otherwise, and they override any prior plan you had. Read on every tool call; act on them before continuing. Skipping a hint is operating on stale information. Errors are token dense and self correcting; the message often names the next call with the team or task list inline. Re-read errors and act on them before falling back to asking the user.

## Iron Law of grounding
Never write what you cannot cite or do not know. Applies wherever an agent generates \`executionRecord\`, \`decisions\`, \`description\`, or \`files\`. When uncertain, write less; a short true record is more valuable than a rich fabricated one. The full quality bar for titles, descriptions, ACs, tag dimensions, categories, edge notes, and markdown tone lives in the skill's \`artifacts.md\`.

## Mutation safety
Update array fields (\`decisions\`, \`acceptanceCriteria\`, \`files\`) APPEND by default. Pass \`overwriteArrays=true\` only when replacing is the intent and the user has confirmed. \`piyaz_task action='delete'\` defaults to \`preview=true\`; show impact, get explicit confirmation, then \`preview=false\`. For abandoned scope prefer \`status='cancelled'\` with rationale in \`executionRecord\` over deletion; edges to cancelled tasks remain in place and cancellation is transitive-aware.

## Remote mode
This is a stateless HTTP endpoint. No session state is persisted server-side. The \`select\` action on \`piyaz_project\` returns a confirmation but does not set server state. Always pass \`projectId\` explicitly on every subsequent call.`;

/**
 * Register all 6 Piyaz tools on a server instance, bound to the caller's
 * auth context. Each tool handler receives `ctx` as its second arg so
 * authorization and team scoping happen inside the data layer.
 * @param server - Any object with a registerTool method (McpServer or mock).
 * @param ctx - Resolved auth context (user id only — team scope per call).
 */
export function registerAllTools(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    "piyaz_project",
    {
      description: DESCRIPTIONS.piyaz_project,
      inputSchema: projectInputSchema,
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
          if (!params.projectId)
            return err(
              "projectId required for select. Call piyaz_project action='list' first to enumerate your projects.",
            );
          return json({
            selected: params.projectId,
            _hints: [
              "Stateless mode. Pass this projectId explicitly on every subsequent call.",
            ],
          });
        }
        const { action, ...rest } = params;
        const result = await handleProject(
          { action: action as "list" | "teams" | "create" | "update", ...rest },
          ctx,
        );
        return toMcp(result);
      } catch (e) {
        return mcpError("piyaz_project", e);
      }
    },
  );

  server.registerTool(
    "piyaz_task",
    {
      description: DESCRIPTIONS.piyaz_task,
      inputSchema: taskInputSchema,
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
        return mcpError("piyaz_task", e);
      }
    },
  );

  server.registerTool(
    "piyaz_edge",
    {
      description: DESCRIPTIONS.piyaz_edge,
      inputSchema: edgeInputSchema,
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
        return mcpError("piyaz_edge", e);
      }
    },
  );

  server.registerTool(
    "piyaz_query",
    {
      description: DESCRIPTIONS.piyaz_query,
      inputSchema: queryInputSchema,
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
        return mcpError("piyaz_query", e);
      }
    },
  );

  server.registerTool(
    "piyaz_context",
    {
      description: DESCRIPTIONS.piyaz_context,
      inputSchema: contextInputSchema,
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
        return mcpError("piyaz_context", e);
      }
    },
  );

  server.registerTool(
    "piyaz_analyze",
    {
      description: DESCRIPTIONS.piyaz_analyze,
      inputSchema: analyzeInputSchema,
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
        return mcpError("piyaz_analyze", e);
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
 * Multi-team callers must pass `organizationId` on `piyaz_project create`;
 * the server returns a hard error with the team list inline otherwise.
 *
 * @param ctx - Resolved auth context derived from the OAuth JWT.
 * @returns Configured McpServer instance.
 */
export function createMcpServer(ctx: AuthContext): McpServer {
  const server = new McpServer(
    {
      name: "piyaz",
      title: "Piyaz",
      version: "0.2.0", // x-release-please-version
      websiteUrl: "https://www.piyaz.ai",
      icons: [
        {
          src: "https://app.piyaz.ai/piyaz-icon-light.png",
          mimeType: "image/png",
          sizes: ["512x512"],
          theme: "light",
        },
        {
          src: "https://app.piyaz.ai/piyaz-icon-dark.png",
          mimeType: "image/png",
          sizes: ["512x512"],
          theme: "dark",
        },
      ],
    },
    { instructions: INSTRUCTIONS },
  );
  registerAllTools(server, ctx);
  return server;
}
