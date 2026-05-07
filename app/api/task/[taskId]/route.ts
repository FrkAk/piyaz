import { getTaskFull } from '@/lib/data/task';
import { getAuthContext } from '@/lib/auth/context';
import { ForbiddenError } from '@/lib/auth/authorization';
import { conditionalRespond } from '@/lib/api/conditional';
import { error } from '@/lib/api/response';

/**
 * Conditional handler for `GET` and `HEAD` on a single task.
 *
 * Returns the full task row + composed `taskRef`. The slim project graph
 * deliberately drops description / implementationPlan / decisions /
 * acceptanceCriteria / executionRecord — TaskTab fetches them lazily
 * through this endpoint when a task is selected.
 *
 * `Last-Modified` is the row's `updatedAt`; the row itself must be
 * loaded to compare so the savings on a 304 come from skipping JSON
 * serialization, not the keyed lookup.
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
    return error('Unauthorized', 401);
  }

  try {
    const task = await getTaskFull(ctx, taskId);
    return conditionalRespond(req, task, task.updatedAt);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return error('Task not found', 404);
    }
    console.error('[task] error:', err);
    return error(err instanceof Error ? err.message : 'Internal error', 500);
  }
}

/**
 * GET handler — returns the full task body.
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
 * @returns Empty response with `Last-Modified` header.
 */
export async function HEAD(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  return handle(req, taskId);
}
