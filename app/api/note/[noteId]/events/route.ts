import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { listNoteActivity } from "@/lib/data/activity";
import { conditionalRespond } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";
import type { NoteActivityEvent } from "@/lib/types";

/**
 * Conditional handler for `GET` and `HEAD` on a note's activity page.
 *
 * Rows are the slim {@link NoteActivityEvent} shape (the note context
 * implies `projectId`/`taskId`/`targetRef`). The ETag folds the newest
 * event's timestamp with its id, so a same-millisecond append still moves
 * the validator; `cursor` and `limit` vary the URL, so each page caches
 * under its own validator. A non-UUID id, a missing/cross-team note,
 * another member's private note, and a trashed note are all 404-shaped
 * (`ForbiddenError` from the data ring; the non-UUID check runs before
 * any SQL).
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
    const events: NoteActivityEvent[] = page.events.map((e) => ({
      id: e.id,
      type: e.type,
      createdAt: e.createdAt,
      actorUserId: e.actorUserId,
      actorName: e.actorName,
      actorAvatar: e.actorAvatar,
      source: e.source,
      agent: e.agent,
      agentVerified: e.agentVerified,
      summary: e.summary,
      metadata: e.metadata,
    }));
    const newest = page.events[0];
    const validator = newest
      ? `${Date.parse(newest.createdAt)}-${newest.id}`
      : "none";
    return conditionalRespond(
      req,
      { events, nextCursor: page.nextCursor },
      validator,
    );
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
