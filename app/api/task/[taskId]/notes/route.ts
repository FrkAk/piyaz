import { getTaskNoteBacklinks } from "@/lib/data/note";
import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { conditionalRespond } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";

/**
 * Conditional handler for `GET` and `HEAD` on a task's linked notes
 * (the DetailView "Linked notes" backlinks).
 *
 * The payload rows are the validator source: the backlinks read IS the
 * cheap slim read (one batch: task gate + slim join), so no dedicated
 * version probe precedes it — a 304 here saves response egress, not DB
 * compute. Rows are the slim tree projection plus the link `kind`;
 * `body`/`search_tsv` are never selected.
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

  try {
    const rows = await getTaskNoteBacklinks(ctx, taskId);
    const maxMs = rows.reduce((m, r) => Math.max(m, r.updatedAt.getTime()), 0);
    const token = `${maxMs}-${rows.length}`;
    return conditionalRespond(req, rows, token);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return error("Task not found", 404);
    }
    return internalError("task-notes", err);
  }
}

/**
 * GET handler — returns the task's linked notes, slim + kind.
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
 * HEAD handler — same auth + 304 logic as GET, never returns a body.
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
