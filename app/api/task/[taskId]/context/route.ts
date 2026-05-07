import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { getTaskFull } from "@/lib/data/task";
import { getProjectMaxUpdatedAt } from "@/lib/data/project";
import { buildAgentContext } from "@/lib/context/_core/agent";
import { buildPlanningContext } from "@/lib/context/_core/planning";
import {
  buildWorkingContext,
  formatWorkingContext,
} from "@/lib/context/_core/working";
import { conditionalRespond, isNotModified } from "@/lib/api/conditional";
import { error } from "@/lib/api/response";

/**
 * Conditional handler for `GET` and `HEAD` on the per-task three-bundle
 * markdown payload (`agent`, `planning`, `working`). Replaces the legacy
 * POST `/api/project/[projectId]/context` endpoint — caller asserts task
 * access first (a missing or cross-team task surfaces as 404) and the URL
 * task id is the authoritative scope.
 *
 * `Last-Modified` is the project-max validator (see
 * {@link getProjectMaxUpdatedAt}) — over-conservative but trivial to
 * compute, and bundle bytes are small enough that occasional false-positive
 * 200s don't matter.
 *
 * @param req - Incoming request.
 * @param taskId - Task UUID from the route params.
 * @returns 200 with `{ agent, planning, working }`, 304, 401, 404, or 500.
 */
async function handle(req: Request, taskId: string): Promise<Response> {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return error("Unauthorized", 401);
  }

  try {
    const task = await getTaskFull(ctx, taskId);
    const max = await getProjectMaxUpdatedAt(ctx, task.projectId);

    if (req.method === "HEAD" || isNotModified(req, max)) {
      return conditionalRespond(req, null, max);
    }

    const [agent, planning, workingRaw] = await Promise.all([
      buildAgentContext(ctx, taskId),
      buildPlanningContext(ctx, taskId),
      buildWorkingContext(ctx, taskId),
    ]);
    const working = await formatWorkingContext(workingRaw);
    return conditionalRespond(req, { agent, planning, working }, max);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return error("Task not found", 404);
    }
    console.error("[task-context] error:", err);
    return error(err instanceof Error ? err.message : "Internal error", 500);
  }
}

/**
 * GET handler — returns the three-bundle markdown payload for a task.
 * @param req - Incoming request.
 * @param params - Route params with taskId.
 * @returns JSON or conditional response.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  return handle(req, taskId);
}

/**
 * HEAD handler — same auth + 304 logic as GET, never returns a body.
 * @param req - Incoming request.
 * @param params - Route params with taskId.
 * @returns Empty response with `Last-Modified` header.
 */
export async function HEAD(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  return handle(req, taskId);
}
