import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { listNoteRevisions } from "@/lib/data/note";
import { conditionalRespond } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";

/**
 * Conditional handler for `GET` and `HEAD` on a note's revision list.
 *
 * Returns slim revision descriptors newest-first (`version`, `title`,
 * `createdBy`, `createdAt`, never `body`) plus the live `currentVersion`.
 * The payload rows are the validator source: the token folds the max
 * version with the row count; retention pruning shrinks the count while a
 * restore grows the max version, so the composite always moves. Revisions
 * are append-only-immutable, so no other mutation can go unseen. A non-UUID
 * id, a missing/cross-team note, another member's private note, and a
 * trashed note are all 404-shaped (`ForbiddenError` from the data ring; the
 * non-UUID check runs before any SQL).
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
    const { currentVersion, revisions } = await listNoteRevisions(ctx, noteId);
    const maxVersion = revisions.length ? revisions[0].version : 0;
    return conditionalRespond(
      req,
      { currentVersion, revisions },
      `${maxVersion}-${revisions.length}`,
    );
  } catch (err) {
    if (err instanceof ForbiddenError) return error("Note not found", 404);
    return internalError("note-revisions", err);
  }
}

/**
 * GET handler: the note's slim revision descriptors, newest-first.
 * @param req - Incoming request.
 * @param params - Route params with noteId.
 * @returns JSON `{ currentVersion, revisions }` or conditional response.
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
