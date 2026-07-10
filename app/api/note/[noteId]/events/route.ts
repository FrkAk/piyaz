import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { listNoteActivity } from "@/lib/data/activity";
import { conditionalRespond } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";

/**
 * Conditional handler for `GET` and `HEAD` on a note's activity page.
 *
 * The payload rows are the validator source: the events read is already the
 * cheap slim read (one batch: note gate + keyset page), so no dedicated
 * version probe precedes it; a 304 saves response egress, not DB compute.
 * The token folds the newest event's `createdAt` ms with the page length —
 * events are append-only, so a new event always moves the pair. `cursor`
 * and `limit` vary the URL, so each page caches under its own validator.
 * A non-UUID id, a missing/cross-team note, another member's private note,
 * and a trashed note are all 404-shaped (`ForbiddenError` from the data
 * ring; the non-UUID check runs before any SQL).
 *
 * @param req - Incoming request; reads `?cursor` and `?limit`.
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
    const url = new URL(req.url);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const page = await listNoteActivity(ctx, noteId, {
      cursor,
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
    });
    const maxMs = page.events.length ? Date.parse(page.events[0].createdAt) : 0;
    return conditionalRespond(req, page, `${maxMs}-${page.events.length}`);
  } catch (err) {
    if (err instanceof ForbiddenError) return error("Note not found", 404);
    return internalError("note-events", err);
  }
}

/**
 * GET handler: one keyset page of the note's activity, newest-first.
 * @param req - Incoming request.
 * @param params - Route params with noteId.
 * @returns JSON `{ events, nextCursor }` or conditional response.
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
