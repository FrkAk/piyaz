import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, assertNoteAccess } from "@/lib/auth/authorization";
import { conditionalRespond, etagMatches } from "@/lib/api/conditional";
import { getNoteFull } from "@/lib/data/note";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";

/**
 * Conditional handler for `GET` and `HEAD` on a single note.
 *
 * Returns the full note row (the only read path that ships `body`)
 * composed with its task mentions (kind + taskRef) and linked notes in
 * both directions. ETag is the note's `updated_at`.
 *
 * Requests that can 304 (HEAD, or GET with `If-None-Match`) run the
 * `assertNoteAccess` probe first so a match skips the five-statement
 * batch that `getNoteFull` pays; the probe 404-shapes trashed notes
 * before the ETag compare, so a matching stale validator cannot 304 a
 * trashed note. Cold GETs skip the probe and authorize through
 * `getNoteFull`, which 404-shapes missing, trashed, and cross-team notes
 * itself.
 *
 * @param req - Incoming request.
 * @param noteId - Note UUID from the route params.
 * @returns 200, 304, 401, 404, or 500.
 */
async function handle(req: Request, noteId: string): Promise<Response> {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return error("Unauthorized", 401);
  }

  try {
    if (req.method === "HEAD" || req.headers.has("if-none-match")) {
      const access = await assertNoteAccess(noteId, ctx);
      if (req.method === "HEAD" || etagMatches(req, access.updatedAt)) {
        return conditionalRespond(req, null, access.updatedAt);
      }
    }

    const result = await getNoteFull(ctx, noteId);
    return conditionalRespond(req, result, result.note.updatedAt);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return error("Note not found", 404);
    }
    return internalError("note", err);
  }
}

/**
 * GET handler: returns the full note with derived link context.
 * @param req - Incoming request.
 * @param params - Route params with noteId.
 * @returns JSON or conditional response.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ noteId: string }> },
) {
  const { noteId } = await params;
  return handle(req, noteId);
}

/**
 * HEAD handler: same auth + 304 logic as GET, never returns a body.
 * @param req - Incoming request.
 * @param params - Route params with noteId.
 * @returns Empty response with `ETag` header.
 */
export async function HEAD(
  req: Request,
  { params }: { params: Promise<{ noteId: string }> },
) {
  const { noteId } = await params;
  return handle(req, noteId);
}
