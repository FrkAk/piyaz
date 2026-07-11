import {
  RateLimitError,
  authorizeWrite,
  type ActionRateLimitConfig,
} from "@/lib/actions/rate-limit-action";
import { ForbiddenError, assertNoteAccess } from "@/lib/auth/authorization";
import { ConsentRequiredError } from "@/lib/auth/consent";
import { requireSession } from "@/lib/auth/session";
import { consentRequiredResponse, internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";
import { broker } from "@/lib/realtime/broker";
import { emitNotePresence } from "@/lib/realtime/events";

/**
 * TTL for the sender's fetch-implicit `note:<id>` subscription, refreshed
 * on every `editing` heartbeat. Mirrors `NOTE_SUBSCRIPTION_TTL_MS` in
 * `app/api/note/[noteId]/route.ts` (the detail route that registers the
 * subscription on fetch).
 */
const NOTE_SUBSCRIPTION_TTL_MS = 10 * 60_000;

/**
 * Heartbeat budget: the client beats every 20s per open team note
 * (3/min), so 30/min covers many tabs while bounding abuse. The per-IP
 * limb runs before the session lookup inside `authorizeWrite`.
 */
const PRESENCE_BUDGET: ActionRateLimitConfig = {
  action: "notePresence",
  windowSeconds: 60,
  perUserMax: 30,
  perIpMax: 60,
};

/** Presence heartbeat body: exactly one `state` field. */
type PresenceBody = { state: "editing" | "gone" };

/**
 * Validate the heartbeat body: exactly `{ state: "editing" | "gone" }`.
 * The body carries no identity by construction; sender identity comes
 * exclusively from the server session.
 *
 * @param body - Parsed JSON body.
 * @returns The narrowed body, or null when invalid.
 */
function parsePresenceBody(body: unknown): PresenceBody | null {
  if (typeof body !== "object" || body === null) return null;
  if (Object.keys(body).length !== 1) return null;
  const state = (body as Record<string, unknown>).state;
  if (state !== "editing" && state !== "gone") return null;
  return { state };
}

/**
 * POST handler: editing-presence heartbeat for a note. Gate order is
 * load-bearing: the rate limit's per-IP limb runs before any session
 * lookup, `assertNoteAccess` runs before any dispatch so a caller can
 * never inject presence into a `note:<id>` channel it cannot read, and
 * missing/trashed/cross-team notes 404-shape for anti-enumeration parity
 * with the other note routes. Presence dispatch is skipped for private
 * notes (their `note:<id>` subscribers are RLS-confined to the creator
 * anyway, so the skip only avoids wasted dispatch). An `editing` beat
 * from a caller with a live realtime connection also refreshes the
 * sender's `note:<id>` subscription TTL, covering long sessions past the
 * 10-minute TTL and dirty-gated notes whose detail refetch (the normal
 * re-registration path) is skipped.
 *
 * @param req - Incoming request with the `{ state }` JSON body.
 * @param params - Route params with noteId.
 * @returns 204, 400, 401, 403 (consent), 404, 429, or 500.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ noteId: string }> },
) {
  const { noteId } = await params;

  let ctx;
  try {
    ctx = await authorizeWrite(PRESENCE_BUDGET);
  } catch (err) {
    if (err instanceof RateLimitError) {
      const res = error("Too many requests", 429);
      res.headers.set("Retry-After", String(err.retryAfter));
      return res;
    }
    if (err instanceof ConsentRequiredError) {
      return consentRequiredResponse(err.outstanding);
    }
    return error("Unauthorized", 401);
  }

  let body: PresenceBody | null;
  try {
    body = parsePresenceBody(await req.json());
  } catch {
    body = null;
  }
  if (body === null) return error("Invalid presence body", 400);

  try {
    const access = await assertNoteAccess(noteId, ctx);
    const session = await requireSession();
    if (access.visibility === "team") {
      emitNotePresence(
        noteId,
        {
          userId: ctx.userId,
          name: session.user.name,
          image: session.user.image ?? null,
        },
        body.state,
      );
    }
    if (body.state === "editing" && broker.hasConnections(ctx.userId)) {
      broker.register(ctx.userId, `note:${noteId}`, NOTE_SUBSCRIPTION_TTL_MS);
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return error("Note not found", 404);
    }
    return internalError("note-presence", err);
  }
}
