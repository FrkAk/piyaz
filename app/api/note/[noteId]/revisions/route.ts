import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { getNoteRevisionsVersion, listNoteRevisions } from "@/lib/data/note";
import { conditionalRespond, etagMatches } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";
import { consentGateResponse } from "@/lib/auth/consent";

/**
 * Conditional handler for `GET` and `HEAD` on a note's revision list.
 *
 * Returns slim checkpoint descriptors newest-first (`version`, `title`,
 * `createdAt`; never `body` or author ids) plus the live `currentVersion`.
 * The ETag folds the live version with the max stored version and the row
 * count: a body write always moves `currentVersion` even when it archived
 * no checkpoint, and pruning shrinks the count. HEAD and `If-None-Match`
 * requests resolve the validator via the `getNoteRevisionsVersion` probe
 * (access gate + one aggregate row) so a 304 avoids the full descriptor
 * fetch; cold GETs skip the probe and derive the same token from the
 * fetched rows. A non-UUID id, a missing/cross-team note, another
 * member's private note, and a trashed note are all 404-shaped
 * (`ForbiddenError` from the data ring; the non-UUID check runs before
 * any SQL).
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

  const gate = await consentGateResponse(ctx.userId);
  if (gate) return gate;

  try {
    if (req.method === "HEAD" || req.headers.has("if-none-match")) {
      const version = await getNoteRevisionsVersion(ctx, noteId);
      const token = `${version.currentVersion}-${version.maxVersion}-${version.count}`;
      if (req.method === "HEAD" || etagMatches(req, token)) {
        return conditionalRespond(req, null, token);
      }
    }

    const { currentVersion, revisions } = await listNoteRevisions(ctx, noteId);
    const rows = revisions.map((r) => ({
      version: r.version,
      title: r.title,
      createdAt: r.createdAt,
    }));
    const maxVersion = rows.length ? rows[0].version : 0;
    return conditionalRespond(
      req,
      { currentVersion, revisions: rows },
      `${currentVersion}-${maxVersion}-${rows.length}`,
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
