import { getTaskNoteBacklinks, type TaskNoteBacklink } from "@/lib/data/note";
import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { conditionalRespond } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";
import { consentGateResponse } from "@/lib/auth/consent";

/**
 * 32-bit FNV-1a hash over the sorted `id:kind` pairs, base-36 encoded.
 * Folds the linked-note set identity and each link's kind into the
 * validator: link mutations bump no note `updated_at`, so without it a
 * swap between notes sharing an `updated_at` millisecond would 304 stale.
 *
 * @param rows - Deduped backlink rows.
 * @returns Fingerprint within the `[A-Za-z0-9._-]` ETag token alphabet.
 */
function linkSetFingerprint(rows: TaskNoteBacklink[]): string {
  const input = rows
    .map((r) => `${r.id}:${r.kind}`)
    .sort()
    .join(",");
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Conditional handler for `GET` and `HEAD` on a task's linked-note
 * backlinks.
 *
 * The payload rows are the validator source: the backlinks read is
 * already the cheap slim read (one batch: task gate + slim join), so no
 * dedicated version probe precedes it; a 304 here saves response egress,
 * not DB compute. The token folds in max `updated_at` ms, row count, and
 * the {@link linkSetFingerprint} of the rows, so link mutations (which
 * bump no note `updated_at`) still invalidate the validator. Rows are
 * the slim tree projection plus the link `kind`; `body`/`search_tsv`
 * are never selected.
 *
 * @param req - Incoming request.
 * @param taskId - Task UUID from the route params.
 * @returns 200, 304, 401, 404, or 500.
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

  try {
    const rows = await getTaskNoteBacklinks(ctx, taskId);
    const maxMs = rows.reduce((m, r) => Math.max(m, r.updatedAt.getTime()), 0);
    const token = `${maxMs}-${rows.length}-${linkSetFingerprint(rows)}`;
    return conditionalRespond(req, rows, token);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return error("Task not found", 404);
    }
    return internalError("task-notes", err);
  }
}

/**
 * GET handler: returns the task's linked notes, slim + kind.
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
