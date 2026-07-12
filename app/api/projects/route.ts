import { getAuthContext } from "@/lib/auth/context";
import {
  getProjectListMaxUpdatedAt,
  listProjectsSlim,
} from "@/lib/data/project";
import { conditionalRespond, etagMatches } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";
import { consentGateResponse } from "@/lib/auth/consent";

/**
 * Conditional handler for `GET` and `HEAD` on the home-grid project list.
 *
 * Keyset-paginated: `?cursor=<token>` seeks past a page boundary and
 * `?limit=<n>` caps the page (clamped 1–100 by the data layer); the response
 * body is `{ rows, nextCursor }`. The ETag validator is the global max
 * `updated_at` across every accessible project, so it stays valid for every
 * page — any change anywhere revalidates the whole list.
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

  const gate = await consentGateResponse(ctx.userId);
  if (gate) return gate;

  try {
    const max = await getProjectListMaxUpdatedAt(ctx);

    if (req.method === "HEAD" || etagMatches(req, max)) {
      return conditionalRespond(req, null, max);
    }

    const params = new URL(req.url).searchParams;
    const cursor = params.get("cursor");
    const limitRaw = params.get("limit");
    const parsedLimit = limitRaw !== null ? Number(limitRaw) : Number.NaN;
    const limit =
      Number.isInteger(parsedLimit) && parsedLimit > 0
        ? parsedLimit
        : undefined;
    const page = await listProjectsSlim(ctx, { cursor, limit });
    return conditionalRespond(req, page, max);
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
