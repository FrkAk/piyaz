import { getNotesTreeVersion, getNoteTreeList } from "@/lib/data/note";
import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { conditionalRespond, etagMatches } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";
import { consentGateResponse } from "@/lib/auth/consent";

/**
 * Conditional handler for `GET` and `HEAD` on the project notes tree list.
 *
 * The validator is the composite token `${maxMetaUpdatedAtMs}-${liveCount}`,
 * built on the notes metadata clock so body-only autosaves answer 304
 * instead of re-shipping every row; the count arm invalidates on soft
 * deletes that lower no MAX, and an empty project yields the stable token
 * `0-0`. Every arm resolves the token via the `getNotesTreeVersion` probe
 * (the rows carry the content clock, not the metadata clock), and a 304
 * skips the tree-list fetch entirely.
 *
 * The payload is the slim {@link import("@/lib/data/note").NoteTreeRow}
 * projection; `body`/`search_tsv` are never selected. Fetch bodies
 * per-note via `GET /api/note/[id]`.
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
    const version = await getNotesTreeVersion(ctx, projectId);
    const token = `${version.maxUpdatedAt?.getTime() ?? 0}-${version.liveCount}`;

    if (req.method === "HEAD" || etagMatches(req, token)) {
      return conditionalRespond(req, null, token);
    }

    const rows = await getNoteTreeList(ctx, projectId);
    return conditionalRespond(req, rows, token);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return error("Project not found", 404);
    }
    return internalError("notes", err);
  }
}

/**
 * GET handler: returns the slim notes tree list.
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
 * HEAD handler: same auth + 304 logic as GET, never returns a body.
 * @param req - Incoming request.
 * @param params - Route params with projectId.
 * @returns Empty response with `ETag` header.
 */
export async function HEAD(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  return handle(req, projectId);
}
