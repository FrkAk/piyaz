import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleWorkspace } from "@/lib/graph/tools/workspace";
import { handleSearch } from "@/lib/graph/tools/search";
import { handleGet } from "@/lib/graph/tools/get";
import { handleCreate } from "@/lib/graph/tools/create";
import { handleEdit } from "@/lib/graph/tools/edit";
import { handleLink } from "@/lib/graph/tools/link";
import { handleMap } from "@/lib/graph/tools/map";
import { handleActivity } from "@/lib/graph/tools/activity";
import type { ToolResult } from "@/lib/graph/tools/shared";
import {
  DESCRIPTIONS,
  workspaceInputSchema,
  searchInputSchema,
  getInputSchema,
  createInputSchema,
  editInputSchema,
  linkInputSchema,
  mapInputSchema,
  activityInputSchema,
} from "@/lib/mcp/schemas";
import { getBackend, MCP_HEAVY_LIMIT } from "@/lib/api/rate-limit";
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
 * Convert a ToolResult to MCP response format.
 * Handles string results (context bundles, formatted views) as raw text.
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

/** MCP content response shape produced by {@link toMcp} / {@link err}. */
type McpResponse = ReturnType<typeof toMcp>;

/**
 * Wrap a tool handler with the cross-cutting concerns every tool shares:
 * the heavy-tier rate check (middleware cannot see tool names, so the
 * expensive shapes are throttled here), the sanitised catch-all (mirrors
 * `internalError` in `lib/api/error.ts`: log server-side, return opaque
 * `Internal error` unless NODE_ENV is exactly `development`), and one
 * structured `mcp_tool` log line per call for observability.
 *
 * @param name - Tool name (e.g. `"piyaz_get"`).
 * @param ctx - Resolved auth context.
 * @param opts - Per-tool hooks: `disc` extracts the action/variant for the
 *   log line; `heavy` marks the parameter shapes billed to the heavy tier.
 * @param handler - The tool handler.
 * @returns The MCP callback.
 */
function wrapTool<P>(
  name: string,
  ctx: AuthContext,
  opts: {
    disc?: (params: P) => string | undefined;
    heavy?: (params: P) => boolean;
  },
  handler: (params: P, ctx: AuthContext) => Promise<ToolResult>,
): (params: P) => Promise<McpResponse> {
  return async (params: P) => {
    const started = Date.now();
    let response: McpResponse;
    let truncated: boolean | undefined;
    let errName: string | undefined;
    try {
      if (opts.heavy?.(params)) {
        const check = await getBackend("mcpHeavy").check(
          `mcp-heavy:${ctx.userId}`,
          MCP_HEAVY_LIMIT.max,
          MCP_HEAVY_LIMIT.window,
        );
        if (!check.allowed) {
          response = err(
            `Heavy-read budget exhausted (${MCP_HEAVY_LIMIT.max}/${MCP_HEAVY_LIMIT.window}s for deep lenses, overviews, wide walks, large batches). Retry in ${check.resetIn}s, or use a lighter shape now: piyaz_get fields=[...], lens='summary', or piyaz_search with filters.`,
          );
          return response;
        }
      }
      const result = await handler(params, ctx);
      if (result.ok) truncated = result.meta?.truncated;
      response = toMcp(result);
      return response;
    } catch (e) {
      console.error(`[mcp:${name}] error:`, e);
      errName = e instanceof Error ? e.name : "unknown";
      const verbose = process.env.NODE_ENV === "development";
      response = err(
        verbose && e instanceof Error ? e.message : "Internal error",
      );
      return response;
    } finally {
      const bytesOut = response!
        ? response!.content.reduce((n, c) => n + c.text.length, 0)
        : 0;
      console.log(
        JSON.stringify({
          evt: "mcp_tool",
          tool: name,
          disc: opts.disc?.(params),
          userId: ctx.userId,
          clientId:
            ctx.actor.source === "mcp" ? (ctx.actor.clientId ?? null) : null,
          ok: !("isError" in response!),
          ms: Date.now() - started,
          bytesOut,
          ...(truncated !== undefined && { truncated }),
          ...(errName !== undefined && { err: errName }),
        }),
      );
    }
  };
}

const INSTRUCTIONS = `Piyaz tracks tasks, dependencies, decisions, and execution records for software projects, so agents and engineers hand work across sessions. 8 tools: piyaz_workspace (identity, projects), piyaz_search (find tasks), piyaz_get (read task/project), piyaz_create (batch create), piyaz_edit (operation edits), piyaz_link (edges), piyaz_map (graph views), piyaz_activity (what changed). Refs are first-class: pass 'PYZ-42' / 'PYZ' anywhere a task/project is named (UUIDs also work); responses emit refs. Stateless server: name the project or task on every call.

Doctrine (persona, tag taxonomy, category vocabulary, full lifecycle table, orchestration) lives in the \`piyaz\` skill on your platform and its references (conventions.md, artifacts.md, lifecycle.md, resilience.md). The skill is ground truth; this server steers.

## Session start
1. piyaz_workspace action='whoami' — confirm who you are and how many teams.
2. piyaz_workspace action='projects' — identifiers for every project (pair with action='teams' when a team is empty or missing).

## Find work
Lead with piyaz_map: view='critical_path' on resume / "what's next" (the bottleneck dictates priority); view='ready' for unblocked planned tasks (pick from ready ∩ critical_path); view='plannable' when nothing is ready to code; view='blocked' to diagnose; view='downstream' task='<ref>' for impact analysis before changes. Drop to piyaz_search for lookups: cross-project by default, filters (status, priority, assignee='me', category, tags) AND-narrow, project='PYZ' scopes and adds derived state.

## Read
Pick the lightest shape: piyaz_get task='<ref>' fields=['<field>'] for one field's exact text (the read before every surgical edit; response carries updatedAt and collection item ids); lens='summary' for orientation with edges; lens='working' for refinement (ids for every criterion/decision/link); lens='agent' BEFORE coding (multi-hop deps, upstream execution records, related tasks); lens='planning' BEFORE writing a plan; lens='review' for in_review tasks; lens='record' for done/cancelled retrospectives. Project: view='meta' for categories + tag vocabulary (check before coining either); view='overview' at most once per session.

## Write
piyaz_create makes 1-25 tasks + edges atomically and is idempotent by exact title (deduped tasks return with their existing refs) — safe to re-run a restarted decompose. piyaz_edit applies ordered ops atomically to one task: str_replace (oldStr must match exactly once — copy exact text from fields=[...] first), append for accretion, set for scalars and full rewrites; add/update/remove/check/uncheck by item id for criteria, decisions, links, assignees. remove is destructive with no undo. Pass ifUpdatedAt (from the last read) on contended tasks; a unique oldStr is an implicit compare-and-swap. Assignee UUIDs come from piyaz_workspace action='members'; category renames/removals go through action='rename_category' / 'delete_category' (they cascade to task rows — update categories=[...] does not).

## Completion Protocol
Run before setting status to in_review, done, or cancelled. The implementer's terminal write is in_review; the HOTL operator flips in_review → done after PR approval. Agents never self-promote to done.
1. Detect mode by transcript. Dispatched (a parent agent invoked you): set in_review directly with the full payload, return a one-sentence summary; do not ask. Direct (normal user session): ask "Ready to mark this in_review?" with a one-sentence executionRecord preview and wait. Uncertain: ask.
2. Populate in ONE piyaz_edit call: set executionRecord (3-5 sentences: file paths, function names, endpoints — HOW it was built, distinct from description), add decisions (CHOICE + WHY, one op each), set files (every path; [] when none), check/uncheck each acceptance criterion by id against the work (never auto-check), set prUrl when a PR was opened, set status='in_review'. The server returns _hints for anything missing; act on them before continuing. For cancelled: executionRecord carries the rationale (why abandoned, what was tried).
3. Open a PR if code changed. Detect a template (.github/PULL_REQUEST_TEMPLATE.md and variants); fill it concisely from executionRecord and ACs; put the ONE primary taskRef in [BRACKETS] in the title (triggers Piyaz PR tracking); plain links for related tasks; 'Closes #N' on its own line when a GitHub issue resolves. No template: Summary / Type of change / Testing / Notes. Empty sections beat fabricated content.
4. Skip the PR for research / decision-only / Piyaz-only tasks; when in doubt, ask.

## Link & propagate
depends_on = source needs target's output (litmus: removing the target makes source impossible; merely harder = relates_to). Notes are REQUIRED and substantive — a brief to the developer starting the source task; placeholders rejected. After any status change or significant refinement: piyaz_map view='downstream' task='<ref>', then update edge notes, retire stale edges, add newly revealed ones, and update downstream descriptions. Cancellation is transparent (dependents stay blocked through the cancelled task's own unsatisfied prereqs): ask whether a replacement exists and rewire, or re-scope dependents. Skipping propagation is how graphs go stale, and stale graphs make Piyaz useless.

## Resume
piyaz_activity project='PYZ' since='<last known instant>' — what changed while you were away, newest first. Then piyaz_get the tasks that moved.

## Hints and errors are runtime instructions
Tool responses carry _hints; errors carry the fix inline (candidate lists for ambiguous refs, the max existing ref on a near-miss, occurrence counts for failed str_replace, current item ids for missed collection targets, the fresh updatedAt on stale writes). They are server-side state you cannot see otherwise and they override your prior plan. Act on them before asking the user. 'Duplicate edge' means the edge exists: treat as success.

## Iron Law of grounding
Never write what you cannot cite or do not know. Applies to executionRecord, decisions, description, files. When uncertain, write less; a short true record beats a rich fabricated one.

## Mutation safety
piyaz_edit remove ops and op='set' full-field rewrites are destructive with no undo (the activity log records that a change happened, not the prior content). Prefer str_replace/append and by-id ops. delete_task previews by default; prefer status='cancelled' for abandoned scope — delete only noise. Confirm destructive intent with the user in direct mode.`;

/**
 * Register all 8 Piyaz tools on a server instance, bound to the caller's
 * auth context. Each handler receives `ctx` so authorization and team
 * scoping happen inside the data layer; `wrapTool` adds the heavy-tier
 * rate check, the sanitised catch-all, and the per-call log line.
 * @param server - Any object with a registerTool method (McpServer or mock).
 * @param ctx - Resolved auth context (user id only — team scope per call).
 */
export function registerAllTools(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    "piyaz_workspace",
    {
      description: DESCRIPTIONS.piyaz_workspace,
      inputSchema: workspaceInputSchema,
      annotations: {
        title: "Workspace",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    wrapTool(
      "piyaz_workspace",
      ctx,
      { disc: (p) => p.action },
      handleWorkspace,
    ),
  );

  server.registerTool(
    "piyaz_search",
    {
      description: DESCRIPTIONS.piyaz_search,
      inputSchema: searchInputSchema,
      annotations: {
        title: "Search Tasks",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapTool("piyaz_search", ctx, {}, handleSearch),
  );

  server.registerTool(
    "piyaz_get",
    {
      description: DESCRIPTIONS.piyaz_get,
      inputSchema: getInputSchema,
      annotations: {
        title: "Get Task or Project",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapTool(
      "piyaz_get",
      ctx,
      {
        disc: (p) => (p.task ? (p.lens ?? "working") : (p.view ?? "meta")),
        heavy: (p) =>
          (Boolean(p.task) &&
            !p.fields?.length &&
            ["agent", "planning", "review", "record"].includes(
              p.lens ?? "working",
            )) ||
          (Boolean(p.project) && p.view === "overview"),
      },
      handleGet,
    ),
  );

  server.registerTool(
    "piyaz_create",
    {
      description: DESCRIPTIONS.piyaz_create,
      inputSchema: createInputSchema,
      annotations: {
        title: "Create Tasks",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapTool(
      "piyaz_create",
      ctx,
      { heavy: (p) => p.tasks.length > 5 || (p.edges?.length ?? 0) > 5 },
      handleCreate,
    ),
  );

  server.registerTool(
    "piyaz_edit",
    {
      description: DESCRIPTIONS.piyaz_edit,
      inputSchema: editInputSchema,
      annotations: {
        title: "Edit Task",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    wrapTool(
      "piyaz_edit",
      ctx,
      { disc: (p) => p.operations.map((o) => o.op).join(",") },
      handleEdit,
    ),
  );

  server.registerTool(
    "piyaz_link",
    {
      description: DESCRIPTIONS.piyaz_link,
      inputSchema: linkInputSchema,
      annotations: {
        title: "Manage Edge",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    wrapTool("piyaz_link", ctx, { disc: (p) => p.action }, handleLink),
  );

  server.registerTool(
    "piyaz_map",
    {
      description: DESCRIPTIONS.piyaz_map,
      inputSchema: mapInputSchema,
      annotations: {
        title: "Map Graph",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapTool(
      "piyaz_map",
      ctx,
      {
        disc: (p) => p.view,
        heavy: (p) =>
          p.view === "critical_path" ||
          (p.view === "neighbors" && p.hops === 2),
      },
      handleMap,
    ),
  );

  server.registerTool(
    "piyaz_activity",
    {
      description: DESCRIPTIONS.piyaz_activity,
      inputSchema: activityInputSchema,
      annotations: {
        title: "Activity Feed",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapTool("piyaz_activity", ctx, {}, handleActivity),
  );
}

/**
 * Create a stateless MCP server bound to the caller's auth context.
 *
 * Read tools span every team the caller is a member of. Writes either name
 * an explicit `organizationId` (membership-checked) or auto-resolve when
 * the caller belongs to exactly one team.
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
