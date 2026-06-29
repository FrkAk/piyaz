import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, assertTaskAccess } from "@/lib/auth/authorization";
import { listTaskActivity } from "@/lib/data/activity";
import { internalError } from "@/lib/api/error";
import { error, ok } from "@/lib/api/response";

/**
 * GET handler — paginated activity for a task, newest-first.
 *
 * @param req - Incoming request; reads `?cursor` and `?limit`.
 * @param params - Route params with `taskId`.
 * @returns 200 with `{ events, nextCursor }`, or 401/404/500.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const { taskId } = await params;

  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return error("Unauthorized", 401);
  }

  try {
    await assertTaskAccess(taskId, ctx);
    const url = new URL(req.url);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const page = await listTaskActivity(ctx, taskId, {
      cursor,
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
    });
    return ok(page);
  } catch (err) {
    if (err instanceof ForbiddenError) return error("Task not found", 404);
    return internalError("task-events", err);
  }
}
