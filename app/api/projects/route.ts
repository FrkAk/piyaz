import { getAuthContext } from "@/lib/auth/context";
import {
  getProjectListMaxUpdatedAt,
  listProjectsSlim,
} from "@/lib/data/project";
import { conditionalRespond, etagMatches } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";

/**
 * Conditional handler for `GET` and `HEAD` on the home-grid project list.
 *
 * Resolves `getProjectListMaxUpdatedAt(ctx)` first so a 304 short-circuit
 * avoids the heavier per-project task-stats roll-up in `listProjectsSlim`.
 *
 * @param req - Incoming request.
 * @returns 200, 304, 401, or 500.
 */
async function handle(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return error("Unauthorized", 401);
  }

  try {
    const max = await getProjectListMaxUpdatedAt(ctx);

    if (req.method === "HEAD" || etagMatches(req, max)) {
      return conditionalRespond(req, null, max);
    }

    const { rows } = await listProjectsSlim(ctx);
    return conditionalRespond(req, rows, max);
  } catch (err) {
    return internalError("projects", err);
  }
}

/**
 * GET handler — returns the home-grid project list.
 * @param req - Incoming request.
 * @returns JSON or conditional response.
 */
export async function GET(req: Request) {
  return handle(req);
}

/**
 * HEAD handler — same auth + 304 logic as GET, never returns a body.
 * @param req - Incoming request.
 * @returns Empty response with `Last-Modified` header.
 */
export async function HEAD(req: Request) {
  return handle(req);
}
