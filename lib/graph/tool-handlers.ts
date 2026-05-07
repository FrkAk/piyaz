/**
 * Tool handlers for the 6 Mymir tools, called by the MCP server.
 * Business logic lives in lib/graph/_core/* and lib/context/_core/*;
 * handlers do validation, authorization, and routing.
 */

import {
  createProject,
  updateProject,
  renameProjectIdentifier,
  listProjectsSlim,
  listUserTeams,
  getProjectTags,
} from "@/lib/data/project";
import {
  createTask,
  updateTask,
  deleteTask,
  deleteTaskPreview,
  reorderTask,
  searchTasks,
  getProjectTasksSlim,
} from "@/lib/data/task";
import {
  createEdge,
  updateEdge,
  removeEdge,
  getTaskEdgesDetailed,
  findEdgeByNodes,
} from "@/lib/data/edge";
import type { TaskState } from "@/lib/data/task";
import { buildProjectOverview } from "@/lib/context/_core/overview";
import { buildSummaryContext } from "@/lib/context/_core/summary";
import {
  buildWorkingContext,
  formatWorkingContext,
} from "@/lib/context/_core/working";
import { buildAgentContext } from "@/lib/context/_core/agent";
import { buildPlanningContext } from "@/lib/context/_core/planning";
import {
  getReadyTasks,
  getBlockedTasks,
  getDownstream,
  getCriticalPath,
  getPlannableTasks,
} from "@/lib/data/traversal";
import type { EdgeType, Decision } from "@/lib/types";
import { parseIdentifier } from "@/lib/graph/identifier";
import type { ProjectUpdate } from "@/lib/data/project";
import type { TaskUpdate } from "@/lib/data/task";
import type { Project } from "@/lib/db/schema";
import {
  MultiTeamAmbiguityError,
  NoTeamMembershipError,
} from "@/lib/graph/errors";
import {
  formatSummary,
  formatSearchResults,
  formatTaskList,
  formatDetailedEdges,
  formatOverview,
  formatReadyTasks,
  formatBlockedTasks,
  formatDownstream,
  formatCriticalPath,
  formatPlannableTasks,
} from "./format-responses";
import { findVariant, normalizeTags } from "./tag-similarity";
import type { AuthContext } from "@/lib/auth/context";
import {
  ForbiddenError,
  InsufficientRoleError,
  assertTaskAccess,
} from "@/lib/auth/authorization";

/**
 * Build variant-warning hints for proposed tags against existing project tags.
 * @param proposed - Proposed tag strings.
 * @param existing - Current project tag list.
 * @returns Hint strings for tags that look like variants of existing ones.
 */
function tagVariantHints(proposed: string[], existing: string[]): string[] {
  const hints: string[] = [];
  for (const tag of proposed) {
    const variant = findVariant(tag, existing);
    if (variant)
      hints.push(
        `Tag "${tag}" looks like a variant of existing "${variant}" — reuse or confirm.`,
      );
  }
  return hints;
}

/**
 * Build warning hints for semantically incoherent terminal-to-terminal
 * status transitions.
 * @param priorStatus - The task's status before the update.
 * @param nextStatus - The status the caller is transitioning to.
 * @returns Hint strings (empty when the transition is normal).
 */
function terminalReversalHints(
  priorStatus: string,
  nextStatus: string,
): string[] {
  if (priorStatus === "done" && nextStatus === "cancelled") {
    return [
      "Transitioning done → cancelled is unusual: it removes this task from the progress numerator and drops the percentage. If the work shipped but is now obsolete, prefer keeping it done and creating a follow-up cancelled task with the rationale, so the historical credit is preserved.",
    ];
  }
  if (priorStatus === "cancelled" && nextStatus === "done") {
    return [
      "Transitioning cancelled → done skips the work pipeline. If the work was actually completed, prefer cancelled → in_progress → done so executionRecord captures what was built rather than the cancellation rationale.",
    ];
  }
  return [];
}

/**
 * Build hints when a task is cancelled.
 * @param payload - Fields supplied by the caller in this request.
 * @param persisted - Row state after the mutation.
 * @returns Hint strings for missing rationale and downstream propagation.
 */
function cancelledStatusHints(
  payload: {
    executionRecord?: string;
    decisions?: Decision[];
  },
  persisted: {
    executionRecord?: string | null;
    decisions?: Decision[] | null;
  },
): string[] {
  const hints: string[] = [];
  if (!payload.executionRecord && !persisted.executionRecord) {
    hints.push(
      "Missing cancellation rationale. Add it to executionRecord — record why this was abandoned and any approaches already tried, so downstream tasks (and future revisits) understand the decision.",
    );
  }
  if (!payload.decisions && (!persisted.decisions || persisted.decisions.length === 0)) {
    hints.push(
      "Missing decisions. Record any technical choices made before cancelling (CHOICE + WHY) — preserves what was learned for future revisits.",
    );
  }
  hints.push(
    "Cancelled is transparent in the dep graph: dependents stay blocked through this task's own unsatisfied deps. Run mymir_analyze type='downstream' to see dependents — if a replacement task should take this one's place, rewire their edges to it.",
  );
  return hints;
}

/**
 * Build completion-protocol hints when a task transitions to or is created
 * in the `done` state.
 * @param payload - Fields supplied by the caller in this request.
 * @param persisted - Row state after the mutation.
 * @returns Hint strings for missing execution metadata and unchecked criteria.
 */
function doneStatusHints(
  payload: {
    executionRecord?: string;
    decisions?: Decision[];
    files?: string[];
  },
  persisted: {
    executionRecord?: string | null;
    decisions?: Decision[] | null;
    files?: string[] | null;
    acceptanceCriteria?: { checked: boolean }[] | null;
  },
): string[] {
  const hints: string[] = [];
  if (!payload.executionRecord && !persisted.executionRecord) {
    hints.push(
      "Missing executionRecord. Add it — downstream tasks depend on this for context.",
    );
  }
  if (!payload.decisions && (!persisted.decisions || persisted.decisions.length === 0)) {
    hints.push(
      "Missing decisions. Record technical choices (CHOICE + WHY) — downstream tasks need them.",
    );
  }
  if (!payload.files && (!persisted.files || persisted.files.length === 0)) {
    hints.push(
      "Missing files. Record every path touched during implementation (empty only if the task genuinely touched no files).",
    );
  }
  hints.push(
    "Run mymir_analyze type='downstream' to propagate changes and update any edges made stale by this completion.",
  );
  const criteria = persisted.acceptanceCriteria;
  if (
    persisted.executionRecord &&
    criteria &&
    criteria.length > 0 &&
    criteria.every((c) => !c.checked)
  ) {
    hints.push(
      "Acceptance criteria are all unchecked. Evaluate each against your executionRecord and re-submit with acceptanceCriteria updated (checked: true/false).",
    );
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Discriminated result from a tool handler. */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/** @returns Success result wrapping data. */
function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

/** @returns Failure result with actionable message. */
function fail(msg: string): ToolResult {
  return { ok: false, error: msg };
}

const STATE_HINTS: Record<TaskState, string> = {
  plannable:
    "Task is plannable. Fetch context with depth='planning' to write an implementation plan.",
  ready:
    "Task is ready to implement. Fetch context with depth='agent' to get implementation context.",
  blocked:
    "Task is blocked by dependencies. Fetch context with depth='working' to see what's blocking it.",
  in_progress:
    "Task is claimed (in progress). Fetch context with depth='working' to review — avoid duplicating work.",
  done: "Task is complete. Fetch context with depth='working' to review what was built.",
  cancelled:
    "Task is cancelled (terminal). Fetch context with depth='working' to review the rationale.",
  draft:
    "Task is a draft (needs description/criteria before planning). Fetch context with depth='working'.",
};

/**
 * Get a context-depth hint for a task's derived state.
 * @param state - The derived TaskState.
 * @returns Hint string telling the agent which context depth to fetch.
 */
function stateHint(state: TaskState): string {
  return STATE_HINTS[state];
}

// ---------------------------------------------------------------------------
// Error translation — data-layer asserts throw, this maps to actionable hints
// ---------------------------------------------------------------------------

/**
 * Translate a thrown error to a token-dense, agent-correcting tool failure.
 *
 * Each branch carries a recovery path the agent can execute on its own:
 * - InsufficientRole: name the action that requires admin so the agent can
 *   tell the user (or the orchestrator) to escalate.
 * - Forbidden: 404-shaped per resource, with the next-tool to call.
 * - MultiTeamAmbiguity: include the team list inline so the agent can
 *   present choices to the user without an extra round trip.
 * - NoTeamMembership: send the user to the web app to create or join.
 *
 * The data-layer assertions tag ForbiddenError with `resource`/`resourceId`,
 * so this layer never re-queries the database.
 *
 * @param e - Caught error.
 */
function translateError(e: unknown): ToolResult {
  if (e instanceof InsufficientRoleError) {
    return fail(
      `Forbidden: only team admins can ${e.primaryAction} projects. Tell the user; they need a team admin to do this.`,
    );
  }
  if (e instanceof MultiTeamAmbiguityError) {
    const list = e.teams.map((t) => `${t.name} (${t.id})`).join(", ");
    return fail(
      `organizationId required: multi-team account. Teams: ${list}. Ask the user which team, then retry with organizationId='<uuid>'. (mymir_project action='teams' returns the same list anytime, with role + projectCount.)`,
    );
  }
  if (e instanceof NoTeamMembershipError) {
    return fail(
      "No team membership: the caller does not belong to any team. Ask the user to sign in to the web app and create or join a team, then retry.",
    );
  }
  if (e instanceof ForbiddenError) {
    const id = e.resourceId ?? "";
    switch (e.resource) {
      case "project":
        return fail(
          `Project '${id}' not found in any team you belong to. Run mymir_project action='list' to see available projects across all your teams.`,
        );
      case "task":
        return fail(
          `Task '${id}' not found in any team you belong to. Run mymir_query type='search' with a projectId, or type='list' to enumerate tasks.`,
        );
      case "edge":
        return fail(
          `Edge '${id}' not found. Run mymir_query type='edges' with a taskId to see current edges on that task.`,
        );
      case "team":
        return fail(
          `organizationId '${id}' is not a team you belong to. Run mymir_project action='teams' to see valid ids, then ask the user which team before retrying.`,
        );
      default:
        return fail(
          "Not found in any team you belong to. Run mymir_project action='list' to see what you can access.",
        );
    }
  }
  return fail(e instanceof Error ? e.message : String(e));
}

// ---------------------------------------------------------------------------
// Shared descriptions (MCP tools are ground truth)
// ---------------------------------------------------------------------------

/** Tool descriptions shared between MCP and web app. */
export const DESCRIPTIONS = {
  mymir_project:
    "Projects + teams across every membership the caller has. " +
    "list=projects with task counts, progress, team metadata (skips empty teams). " +
    "teams=every membership (id, name, slug, role, projectCount) — call before create or when list misses a team. " +
    "create=new project (REQUIRES organizationId in multi-team accounts; auto-resolves for single-team; rejected with team list inline otherwise). " +
    "select=confirm working project (returns projectId — pass it on every subsequent call; stateless server). " +
    "update=change title, description, status, categories, or identifier.",
  mymir_task:
    "Create, update, delete, or reorder tasks. " +
    "Status lifecycle: draft → planned → in_progress → done. " +
    "cancelled is terminal abandoned work with transparent deps — populate executionRecord with rationale; dependents stay blocked through the cancelled task's own unsatisfied prereqs. " +
    "Before marking done, follow the skill's Completion Protocol. " +
    "delete: preview=true (default) shows impact without deleting; set preview=false to execute. " +
    "update: pass only changed fields. Array fields (decisions, acceptanceCriteria, files) APPEND by default — set overwriteArrays=true to replace.",
  mymir_edge:
    "Manage dependency edges between tasks. " +
    "create=link two tasks (depends_on = source blocks on target; relates_to = informational). " +
    "update=change edgeType or note by edgeId. " +
    "remove=delete by edgeId OR by sourceTaskId+targetTaskId+edgeType. " +
    "Server rejects self-edges, duplicates, and cycles.",
  mymir_query:
    "Search and browse project data. " +
    "search=find tasks by taskRef, title, or tag substring (case-insensitive, up to 20). Pass `tags` to filter by exact tag (OR-within); combine with `query` to narrow. " +
    "list=all tasks ordered by position. " +
    "edges=relationships on a task (connected title, status, direction, note). " +
    "overview=full project structure (tasks, deps, progress, tag vocab).",
  mymir_context:
    "Retrieve task context at varying depth. ALWAYS fetch context before reasoning about a task. " +
    "summary=quick (title, status, edge counts). " +
    "working=detailed (criteria, decisions, 1-hop edges, siblings). " +
    "agent=multi-hop dependency chains with execution records (coding context, ~4-8K tokens). " +
    "planning=spec-focused (project description, prereqs, acceptance criteria, downstream specs).",
  mymir_analyze:
    "Analyze the project dependency graph. " +
    "ready=tasks with all deps done — pick from these first. " +
    "plannable=draft tasks ready for planning when nothing is ready to code. " +
    "blocked=tasks waiting on unfinished deps with blocker details. " +
    "downstream=transitive dependents of a task — impact analysis before changes. " +
    "critical_path=longest dep chain — the bottleneck to prioritize.",
} as const;

// ---------------------------------------------------------------------------
// Param types
// ---------------------------------------------------------------------------

/** Params for mymir_project (handler covers list/create/update/teams; MCP handles select separately). */
export type ProjectParams = {
  action: "list" | "create" | "update" | "teams";
  projectId?: string;
  title?: string;
  description?: string;
  status?: "brainstorming" | "decomposing" | "active" | "archived";
  categories?: string[];
  identifier?: string;
  /**
   * Target team UUID for `create`. Required when the caller is a member
   * of more than one team. Membership in the supplied team is enforced
   * server-side; cross-team probes return a 404-shaped 'not found'.
   */
  organizationId?: string;
};

/** Params for mymir_task. */
export type TaskParams = {
  action: "create" | "update" | "delete" | "reorder";
  projectId?: string;
  taskId?: string;
  title?: string;
  description?: string;
  status?: "draft" | "planned" | "in_progress" | "done" | "cancelled";
  acceptanceCriteria?: unknown[];
  decisions?: unknown[];
  tags?: string[];
  category?: string;
  files?: string[];
  implementationPlan?: string;
  executionRecord?: string;
  order?: number;
  preview?: boolean;
  overwriteArrays?: boolean;
};

/** Params for mymir_edge. */
export type EdgeParams = {
  action: "create" | "update" | "remove";
  edgeId?: string;
  sourceTaskId?: string;
  targetTaskId?: string;
  edgeType?: "depends_on" | "relates_to";
  note?: string;
};

/** Params for mymir_query. */
export type QueryParams = {
  type: "search" | "list" | "edges" | "overview";
  projectId?: string;
  query?: string;
  tags?: string[];
  taskId?: string;
};

/** Params for mymir_context. */
export type ContextParams = {
  taskId: string;
  depth: "summary" | "working" | "agent" | "planning";
  projectId?: string;
};

/** Params for mymir_analyze. */
export type AnalyzeParams = {
  type: "ready" | "blocked" | "downstream" | "critical_path" | "plannable";
  projectId?: string;
  taskId?: string;
};

// ---------------------------------------------------------------------------
// Handlers — all take ctx as the second arg
// ---------------------------------------------------------------------------

/**
 * Handle mymir_project actions (list/create/update).
 * @param p - Validated project params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with project data.
 */
export async function handleProject(
  p: ProjectParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.action) {
      case "list":
        return ok((await listProjectsSlim(ctx)).rows);
      case "teams":
        return ok(await listUserTeams(ctx));
      case "create": {
        if (!p.title) return fail("title required for create (2-5 words, verb-noun preferred)");
        let parsedIdentifier;
        if (p.identifier !== undefined) {
          const parsed = parseIdentifier(p.identifier);
          if (!parsed.ok) return fail(parsed.error);
          parsedIdentifier = parsed.value;
        }
        const project = await createProject(ctx, {
          title: p.title,
          description: p.description ?? "",
          ...(p.status !== undefined && { status: p.status }),
          categories: p.categories,
          identifier: parsedIdentifier,
          organizationId: p.organizationId,
        });
        const createHints: string[] = [];
        if (p.identifier === undefined) {
          createHints.push(
            `Auto-derived identifier '${project.identifier}' from title. Pass identifier='...' to override (2-12 chars, uppercase alphanumeric, unique per team).`,
          );
        }
        return ok(createHints.length > 0 ? { ...project, _hints: createHints } : project);
      }
      case "update": {
        if (!p.projectId) return fail("projectId required for update");
        if (
          p.title === undefined &&
          p.description === undefined &&
          p.status === undefined &&
          p.categories === undefined &&
          p.identifier === undefined
        ) {
          return fail(
            "update requires at least one of: title, description, status, categories, identifier.",
          );
        }
        const changes: ProjectUpdate = {};
        if (p.title !== undefined) changes.title = p.title;
        if (p.description !== undefined) changes.description = p.description;
        if (p.status !== undefined) changes.status = p.status;
        if (p.categories !== undefined) changes.categories = p.categories;

        let project: Project | undefined;
        if (p.identifier !== undefined) {
          const parsed = parseIdentifier(p.identifier);
          if (!parsed.ok) return fail(parsed.error);
          project = await renameProjectIdentifier(ctx, p.projectId, parsed.value);
        }
        if (Object.keys(changes).length > 0) {
          project = await updateProject(ctx, p.projectId, changes);
        }

        const updateHints: string[] = [];
        if (p.identifier !== undefined) {
          updateHints.push(
            `Renamed all task refs to '${p.identifier}-N'. External references (GitHub PRs, docs, commit messages) to the old prefix no longer resolve.`,
          );
        }
        return ok(
          updateHints.length > 0
            ? { ...project, _hints: updateHints }
            : project,
        );
      }
    }
  } catch (e) {
    return translateError(e);
  }
}

/**
 * Handle mymir_task actions.
 * @param p - Validated task params. projectId required for create.
 * @param ctx - Resolved auth context.
 * @returns Tool result with task data.
 */
export async function handleTask(
  p: TaskParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.action) {
      case "create": {
        if (!p.projectId) return fail("projectId required for create");
        if (!p.title) return fail("title required for create");
        if (!p.description)
          return fail(
            "description required for create (2-4 sentences: what, why, how)",
          );
        const preExistingTags =
          p.tags && p.tags.length > 0
            ? (await getProjectTags(ctx, p.projectId)).map((t) => t.tag)
            : [];
        const task = await createTask(ctx, {
          projectId: p.projectId,
          title: p.title,
          description: p.description,
          status: p.status,
          order: p.order ?? 0,
          acceptanceCriteria: (p.acceptanceCriteria ?? []) as unknown as {
            id: string;
            text: string;
            checked: boolean;
          }[],
          tags: p.tags,
          category: p.category,
          files: p.files,
          implementationPlan: p.implementationPlan,
          executionRecord: p.executionRecord,
          decisions: p.decisions as unknown as Decision[],
        });
        const createHints: string[] = [];
        createHints.push("No edges. Add dependencies with mymir_edge.");
        if (!p.category) {
          createHints.push(
            "No category. Use mymir_project to see project categories, then set one with mymir_task action='update'.",
          );
        }
        if (!p.acceptanceCriteria || p.acceptanceCriteria.length === 0) {
          createHints.push(
            "No acceptance criteria. Add testable done conditions with mymir_task action='update'.",
          );
        }
        if (p.tags && p.tags.length > 0) {
          createHints.push(...tagVariantHints(p.tags, preExistingTags));
        }
        if (p.status === "done") {
          const persisted = await assertTaskAccess(task.id, ctx);
          if (persisted) {
            createHints.push(
              ...doneStatusHints(
                {
                  executionRecord: p.executionRecord,
                  decisions: p.decisions as Decision[] | undefined,
                  files: p.files,
                },
                {
                  executionRecord: persisted.executionRecord,
                  decisions: persisted.decisions as Decision[] | null,
                  files: persisted.files,
                  acceptanceCriteria:
                    persisted.acceptanceCriteria as { checked: boolean }[] | null,
                },
              ),
            );
          }
        }
        if (p.status === "cancelled") {
          const persisted = await assertTaskAccess(task.id, ctx);
          if (persisted) {
            createHints.push(
              ...cancelledStatusHints(
                {
                  executionRecord: p.executionRecord,
                  decisions: p.decisions as Decision[] | undefined,
                },
                {
                  executionRecord: persisted.executionRecord,
                  decisions: persisted.decisions as Decision[] | null,
                },
              ),
            );
          }
        }
        return ok({ ...task, _hints: createHints });
      }
      case "update": {
        if (!p.taskId)
          return fail(
            "taskId required for update. Use mymir_query type='search' to find it.",
          );
        if (
          p.title === undefined &&
          p.description === undefined &&
          p.status === undefined &&
          p.acceptanceCriteria === undefined &&
          p.decisions === undefined &&
          p.tags === undefined &&
          p.category === undefined &&
          p.files === undefined &&
          p.implementationPlan === undefined &&
          p.executionRecord === undefined
        ) {
          return fail(
            "update requires at least one of: title, description, status, acceptanceCriteria, decisions, tags, category, files, implementationPlan, executionRecord.",
          );
        }
        let preExistingTags: string[] = [];
        let priorStatus: string | undefined;
        if (p.tags && p.tags.length > 0) {
          const existing = await assertTaskAccess(p.taskId, ctx);
          if (existing) {
            preExistingTags = (
              await getProjectTags(ctx, existing.projectId)
            ).map((t) => t.tag);
            priorStatus = existing.status;
          }
        }
        if (p.status !== undefined && priorStatus === undefined) {
          const existing = await assertTaskAccess(p.taskId, ctx);
          if (existing) priorStatus = existing.status;
        }
        const changes: TaskUpdate = {};
        if (p.title !== undefined) changes.title = p.title;
        if (p.description !== undefined) changes.description = p.description;
        if (p.status !== undefined) changes.status = p.status;
        if (p.acceptanceCriteria !== undefined)
          changes.acceptanceCriteria = p.acceptanceCriteria;
        if (p.decisions !== undefined) changes.decisions = p.decisions;
        if (p.tags !== undefined) changes.tags = p.tags;
        if (p.category !== undefined) changes.category = p.category;
        if (p.files !== undefined) changes.files = p.files;
        if (p.implementationPlan !== undefined)
          changes.implementationPlan = p.implementationPlan;
        if (p.executionRecord !== undefined)
          changes.executionRecord = p.executionRecord;
        const result = await updateTask(ctx, p.taskId, changes, !!p.overwriteArrays);
        const updateHints: string[] = [];
        if (p.tags && p.tags.length > 0) {
          updateHints.push(...tagVariantHints(p.tags, preExistingTags));
        }
        if (p.status === "planned") {
          updateHints.push(
            "Task planned. Claim with status='in_progress' when ready to implement.",
          );
        }
        if (p.status === "in_progress") {
          updateHints.push(
            "Run mymir_context depth='agent' to get implementation context before starting.",
          );
          updateHints.push(
            "Before marking done: confirm with the user (single-agent mode) or return to the orchestrator (dispatched mode). See Completion Protocol in the skill.",
          );
        }
        if (p.status === "done") {
          updateHints.push(
            ...doneStatusHints(
              {
                executionRecord: p.executionRecord,
                decisions: p.decisions as Decision[] | undefined,
                files: p.files,
              },
              {
                executionRecord: result.executionRecord,
                decisions: result.decisions as Decision[] | null,
                files: result.files,
                acceptanceCriteria:
                  result.acceptanceCriteria as { checked: boolean }[] | null,
              },
            ),
          );
        }
        if (p.status === "cancelled") {
          updateHints.push(
            ...cancelledStatusHints(
              {
                executionRecord: p.executionRecord,
                decisions: p.decisions as Decision[] | undefined,
              },
              {
                executionRecord: result.executionRecord,
                decisions: result.decisions as Decision[] | null,
              },
            ),
          );
        }
        if (
          priorStatus !== undefined &&
          p.status !== undefined &&
          priorStatus !== p.status
        ) {
          updateHints.push(...terminalReversalHints(priorStatus, p.status));
        }
        return ok(
          updateHints.length > 0 ? { ...result, _hints: updateHints } : result,
        );
      }
      case "delete": {
        if (!p.taskId) return fail("taskId required for delete");
        if (p.preview !== false) {
          const result = await deleteTaskPreview(ctx, p.taskId);
          return ok({
            ...result,
            _hints: ["Preview only. Run again with preview=false to delete."],
          });
        }
        return ok(await deleteTask(ctx, p.taskId));
      }
      case "reorder": {
        if (!p.taskId) return fail("taskId required for reorder");
        if (p.order === undefined)
          return fail("order required for reorder (0-based position)");
        return ok(await reorderTask(ctx, p.taskId, p.order));
      }
    }
  } catch (e) {
    return translateError(e);
  }
}

/**
 * Handle mymir_edge actions.
 * @param p - Validated edge params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with edge data.
 */
export async function handleEdge(
  p: EdgeParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.action) {
      case "create": {
        if (!p.sourceTaskId || !p.targetTaskId)
          return fail("sourceTaskId and targetTaskId required for create");
        if (!p.edgeType)
          return fail(
            "edgeType required for create (depends_on or relates_to)",
          );
        const edge = await createEdge(ctx, {
          sourceTaskId: p.sourceTaskId,
          targetTaskId: p.targetTaskId,
          edgeType: p.edgeType as EdgeType,
          note: p.note ?? "",
        });
        const edgeHints: string[] = [];
        if (!p.note) {
          edgeHints.push(
            "Missing edge note. Add one — notes propagate to downstream agent context.",
          );
        }
        return ok(edgeHints.length > 0 ? { ...edge, _hints: edgeHints } : edge);
      }
      case "update": {
        if (!p.edgeId)
          return fail(
            "edgeId required for update. Use mymir_query type='edges' to find edge IDs.",
          );
        if (p.edgeType === undefined && p.note === undefined)
          return fail(
            "update requires at least one of: edgeType, note. " +
              "To remove the edge, use action='remove'.",
          );
        return ok(
          await updateEdge(ctx, p.edgeId, {
            edgeType: p.edgeType as EdgeType | undefined,
            note: p.note,
          }),
        );
      }
      case "remove": {
        if (p.edgeId) {
          await removeEdge(ctx, p.edgeId);
          return ok({ removed: p.edgeId });
        }
        if (p.sourceTaskId && p.targetTaskId && p.edgeType) {
          const edge = await findEdgeByNodes(
            ctx,
            p.sourceTaskId,
            p.targetTaskId,
            p.edgeType as EdgeType,
          );
          if (!edge) {
            return fail(
              `No matching edge for ${p.sourceTaskId} -[${p.edgeType}]-> ${p.targetTaskId}. ` +
                `Use mymir_query type='edges' to list current edges.`,
            );
          }
          await removeEdge(ctx, edge.id);
          return ok({ removed: edge.id });
        }
        return fail(
          "Provide edgeId OR sourceTaskId+targetTaskId+edgeType. " +
            "Use mymir_query type='edges' to find edge details.",
        );
      }
    }
  } catch (e) {
    return translateError(e);
  }
}

/**
 * Handle mymir_query actions.
 * @param p - Validated query params. projectId required for search/list/overview.
 * @param ctx - Resolved auth context.
 * @returns Tool result with query data.
 */
export async function handleQuery(
  p: QueryParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.type) {
      case "search": {
        if (!p.projectId) return fail("projectId required for search");
        const hasQuery = (p.query?.trim() ?? "").length > 0;
        const tagFilter = normalizeTags(p.tags);
        if (!hasQuery && tagFilter.length === 0) {
          return fail("query or tags required for search");
        }

        const variantHints =
          tagFilter.length > 0
            ? tagVariantHints(
                tagFilter,
                (await getProjectTags(ctx, p.projectId)).map((t) => t.tag),
              )
            : [];

        const results = await searchTasks(ctx, p.projectId, p.query, tagFilter);
        const hintParts: string[] = [...variantHints];
        if (results.length === 1) hintParts.push(stateHint(results[0].state));
        const hint = hintParts.length > 0 ? hintParts.join("\n> ") : undefined;
        return ok(formatSearchResults(results, hint));
      }
      case "list": {
        if (!p.projectId) return fail("projectId required for list");
        return ok(formatTaskList(await getProjectTasksSlim(ctx, p.projectId)));
      }
      case "edges": {
        if (!p.taskId)
          return fail(
            "taskId required for edges. Use type='search' to find task IDs.",
          );
        return ok(formatDetailedEdges(await getTaskEdgesDetailed(ctx, p.taskId)));
      }
      case "overview": {
        if (!p.projectId) return fail("projectId required for overview");
        const overview = await buildProjectOverview(ctx, p.projectId);
        return ok(overview ? formatOverview(overview) : "Project not found.");
      }
    }
  } catch (e) {
    return translateError(e);
  }
}

/**
 * Handle mymir_context actions. Returns structured data for summary depth,
 * formatted string for other depths.
 * @param p - Validated context params. projectId required for working depth.
 * @param ctx - Resolved auth context.
 * @returns Tool result.
 */
export async function handleContext(
  p: ContextParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.depth) {
      case "summary":
        return ok(formatSummary(await buildSummaryContext(ctx, p.taskId)));
      case "working": {
        if (!p.projectId)
          return fail("projectId required for working depth");
        // assertTaskAccess gates on membership; the projectId comparison protects
        // against passing a different project's UUID alongside our own task.
        const task = await assertTaskAccess(p.taskId, ctx);
        if (task.projectId !== p.projectId) {
          return fail(
            `Task '${p.taskId}' belongs to project '${task.projectId}', not '${p.projectId}'. ` +
              `Run mymir_query type='search' to find the correct projectId.`,
          );
        }
        const result = await buildWorkingContext(ctx, p.taskId);
        return ok(await formatWorkingContext(result));
      }
      case "agent":
        return ok(await buildAgentContext(ctx, p.taskId));
      case "planning":
        return ok(await buildPlanningContext(ctx, p.taskId));
    }
  } catch (e) {
    return translateError(e);
  }
}

/**
 * Handle mymir_analyze actions.
 * @param p - Validated analyze params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with analysis data.
 */
export async function handleAnalyze(
  p: AnalyzeParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.type) {
      case "ready": {
        if (!p.projectId) return fail("projectId required for ready");
        return ok(formatReadyTasks(await getReadyTasks(ctx, p.projectId)));
      }
      case "blocked": {
        if (!p.projectId) return fail("projectId required for blocked");
        return ok(formatBlockedTasks(await getBlockedTasks(ctx, p.projectId)));
      }
      case "downstream": {
        if (!p.taskId)
          return fail(
            "taskId required for downstream analysis. Use mymir_query type='search' to find it.",
          );
        return ok(formatDownstream(await getDownstream(ctx, p.taskId)));
      }
      case "critical_path": {
        if (!p.projectId) return fail("projectId required for critical_path");
        return ok(formatCriticalPath(await getCriticalPath(ctx, p.projectId)));
      }
      case "plannable": {
        if (!p.projectId) return fail("projectId required for plannable");
        return ok(
          formatPlannableTasks(await getPlannableTasks(ctx, p.projectId)),
        );
      }
    }
  } catch (e) {
    return translateError(e);
  }
}
