import { getTaskNoteContext } from "@/lib/data/note";
import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { conditionalRespond } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";
import { consentGateResponse } from "@/lib/auth/consent";
import { BUNDLE_KINDS, type BundleKind } from "@/lib/context/parts";
import { NOTE_FEED_RULES, buildBundleNoteView } from "@/lib/context/format";

/**
 * 32-bit FNV-1a hash over the serialized payload, base-36 encoded.
 *
 * The payload is the validator source. A note-derived token cannot cover
 * this response: feed membership also turns on the task's category and
 * tags (retagging a task bumps no note `updated_at` and no link row) and
 * on each note's own feed settings (a note leaving the feed is absent
 * from the rows a max-`updated_at` probe would see). Hashing what is
 * actually returned is the only validator that observes every input.
 *
 * The caller pairs this with the task's `updated_at` and the row counts,
 * so a 32-bit collision alone cannot serve a stale 304.
 *
 * @param payload - The response body about to be sent.
 * @returns Fingerprint within the `[A-Za-z0-9._-]` ETag token alphabet.
 */
function payloadFingerprint(payload: unknown): string {
  const input = JSON.stringify(payload);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Conditional handler for `GET` and `HEAD` on a task's note context: the
 * linked-note backlinks the detail panel renders, plus the note links the
 * context bundle of `?bundle=<kind>` will carry.
 *
 * Both halves ride one request so the detail panel never pays a second
 * round trip. The feed half is links only: guidance bodies are charged
 * against the feed budget server-side but never leave it.
 *
 * @param req - Incoming request.
 * @param taskId - Task UUID from the route params.
 * @returns 200, 304, 400, 401, 404, or 500.
 */
async function handle(req: Request, taskId: string): Promise<Response> {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return error("Unauthorized", 401);
  }

  const gate = await consentGateResponse(ctx.userId);
  if (gate) return gate;

  const kind = new URL(req.url).searchParams.get("bundle");
  if (kind === null || !BUNDLE_KINDS.includes(kind as BundleKind)) {
    return error("Unknown bundle kind", 400);
  }
  const bundle = kind as BundleKind;

  try {
    const context = await getTaskNoteContext(
      ctx,
      taskId,
      NOTE_FEED_RULES[bundle].deep,
    );
    const payload = {
      backlinks: context.backlinks,
      feed: buildBundleNoteView(context.feed, bundle),
    };
    const token = [
      context.taskUpdatedAt.getTime(),
      payload.backlinks.length,
      payload.feed.notes.length,
      payload.feed.guidance.length,
      payloadFingerprint(payload),
    ].join("-");
    return conditionalRespond(req, payload, token);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return error("Task not found", 404);
    }
    return internalError("task-notes", err);
  }
}

/**
 * GET handler: the task's linked notes plus its bundle note feed.
 * @param req - Incoming request.
 * @param params - Route params with taskId.
 * @returns JSON or conditional response.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  return handle(req, taskId);
}

/**
 * HEAD handler: same auth + 304 logic as GET, never returns a body.
 * @param req - Incoming request.
 * @param params - Route params with taskId.
 * @returns Empty response with `ETag` header.
 */
export async function HEAD(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  return handle(req, taskId);
}
