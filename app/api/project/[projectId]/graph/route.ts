import {
  getProjectGraphSlim,
  getProjectMaxUpdatedAt,
} from "@/lib/data/project";
import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { conditionalRespond, etagMatches } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";
import { consentGateResponse } from "@/lib/auth/consent";

/**
 * Conditional handler for `GET` and `HEAD` on the project slim graph.
 *
 * Resolves `max(updated_at)` first via a single GREATEST query so a 304
 * short-circuit (or a HEAD) avoids the heavier slim-graph fetch. Returns
 * `200 application/json` with the slim graph payload when the client has
 * no cached validator or its `If-Modified-Since` is older than the
 * resource's max timestamp; otherwise `304` with the `Last-Modified`
 * header echoed.
 *
 * Heavy task fields (`description`, `implementationPlan`, `decisions`,
 * `acceptanceCriteria`, `executionRecord`, `files`) are
 * deliberately omitted — fetch them per-task via `GET /api/task/[id]`.
 *
 * @param req - Incoming request.
 * @param projectId - Project UUID from the route params.
 * @returns 200, 304, 401, 404, or 500.
 */
async function handle(req: Request, projectId: string): Promise<Response> {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return error("Unauthorized", 401);
  }

  const gate = await consentGateResponse(ctx.userId);
  if (gate) return gate;

  try {
    const max = await getProjectMaxUpdatedAt(ctx, projectId);

    if (req.method === "HEAD" || etagMatches(req, max)) {
      return conditionalRespond(req, null, max);
    }

    const body = await getProjectGraphSlim(ctx, projectId);
    return conditionalRespond(req, body, max);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return error("Project not found", 404);
    }
    return internalError("graph", err);
  }
}

/**
 * GET handler — returns the slim project graph.
 * @param req - Incoming request.
 * @param params - Route params with projectId.
 * @returns JSON or conditional response.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  return handle(req, projectId);
}

/**
 * HEAD handler — same auth + 304 logic as GET, never returns a body.
 * @param req - Incoming request.
 * @param params - Route params with projectId.
 * @returns Empty response with `Last-Modified` header.
 */
export async function HEAD(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  return handle(req, projectId);
}
