import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, assertNoteAccess } from "@/lib/auth/authorization";
import { conditionalRespond, etagMatches } from "@/lib/api/conditional";
import { getNoteFull } from "@/lib/data/note";
import { broker } from "@/lib/realtime/broker";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";
import { consentGateResponse } from "@/lib/auth/consent";

/** TTL for fetch-implicit note subscriptions: 10 minutes. */
const NOTE_SUBSCRIPTION_TTL_MS = 10 * 60_000;

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
 * A 200 body response registers the fetch-implicit `note:<id>` broker
 * subscription (TTL {@link NOTE_SUBSCRIPTION_TTL_MS}), the channel
 * private-note events dispatch on, mirroring the `task:<id>` pattern in
 * the task detail route. Registration is skipped on HEAD/304 (cache
 * probes, not "user is viewing" signals) and when the caller has no live
 * realtime connection, so a connection-less caller cannot leak an entry
 * into their submap until the TTL elapses.
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
      const access = await assertNoteAccess(noteId, ctx);
      if (req.method === "HEAD" || etagMatches(req, access.updatedAt)) {
        return conditionalRespond(req, null, access.updatedAt);
      }
    }

    const result = await getNoteFull(ctx, noteId);
    if (broker.hasConnections(ctx.userId)) {
      broker.register(ctx.userId, `note:${noteId}`, NOTE_SUBSCRIPTION_TTL_MS);
    }
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
