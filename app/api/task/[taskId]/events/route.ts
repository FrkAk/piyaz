import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { getTaskActivityHead, listTaskActivity } from "@/lib/data/activity";
import { conditionalRespond, etagMatches } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";
import { consentGateResponse } from "@/lib/auth/consent";

/**
 * Conditional handler for `GET` and `HEAD` on a task's activity page.
 *
 * The ETag folds the newest event's timestamp with its id, so a
 * same-millisecond append still moves the validator; `cursor` and `limit`
 * vary the URL, so each page caches under its own validator. HEAD and
 * `If-None-Match` requests resolve the validator via the
 * `getTaskActivityHead` probe (existence gate + one index-head row, no
 * identity joins) so a 304 avoids the full page fetch. A missing or
 * cross-team task is 404-shaped (`ForbiddenError` from the data ring).
 *
 * @param req - Incoming request; reads `?cursor` and `?limit`.
 * @param taskId - Task UUID from the route params.
 * @returns 200, 304, 401, 404, or 500.
 */
async function handle(req: Request, taskId: string): Promise<Response> {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return error("Unauthorized", 401);
  }

  const gate = await consentGateResponse(ctx.userId);
  if (gate) return gate;

  try {
    const url = new URL(req.url);
    const cursor = url.searchParams.get("cursor") ?? undefined;

    if (req.method === "HEAD" || req.headers.has("if-none-match")) {
      const head = await getTaskActivityHead(ctx, taskId, { cursor });
      const token = head ? `${head.createdAtMs}-${head.id}` : "none";
      if (req.method === "HEAD" || etagMatches(req, token)) {
        return conditionalRespond(req, null, token);
      }
    }

    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const page = await listTaskActivity(ctx, taskId, {
      cursor,
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
    });
    const newest = page.events[0];
    const validator = newest
      ? `${Date.parse(newest.createdAt)}-${newest.id}`
      : "none";
    return conditionalRespond(req, page, validator);
  } catch (err) {
    if (err instanceof ForbiddenError) return error("Task not found", 404);
    return internalError("task-events", err);
  }
}

/**
 * GET handler: one keyset page of the task's activity, newest-first.
 * @param req - Incoming request.
 * @param params - Route params with `taskId`.
 * @returns JSON `{ events, nextCursor }` or conditional response.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const { taskId } = await params;
  return handle(req, taskId);
}

/**
 * HEAD handler: same auth + 304 logic as GET, never returns a body.
 * @param req - Incoming request.
 * @param params - Route params with `taskId`.
 * @returns Empty response with `ETag` header.
 */
export async function HEAD(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const { taskId } = await params;
  return handle(req, taskId);
}
