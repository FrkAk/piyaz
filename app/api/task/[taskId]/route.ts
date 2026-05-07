import { getTaskFull } from '@/lib/data/task';
import { getAuthContext } from '@/lib/auth/context';
import { ForbiddenError } from '@/lib/auth/authorization';
import { conditionalRespond } from '@/lib/api/conditional';
import { broker } from '@/lib/realtime/broker';
import { error } from '@/lib/api/response';

/** TTL for fetch-implicit task subscriptions — 10 minutes. */
const TASK_SUBSCRIPTION_TTL_MS = 10 * 60_000;

/**
 * Conditional handler for `GET` and `HEAD` on a single task.
 *
 * Returns the full task row + composed `taskRef`. The slim project graph
 * deliberately drops description / implementationPlan / decisions /
 * acceptanceCriteria / executionRecord — the workspace fetches them
 * lazily through this endpoint when a task is selected.
 *
 * `Last-Modified` is the row's `updatedAt`. The row must be loaded to
 * obtain the validator, so a 304 here only saves JSON serialization +
 * wire bytes — not the keyed lookup. The conditional contract is
 * primarily here for the upcoming TanStack Query integration; the
 * current client does not yet send `If-Modified-Since` for this route.
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
    broker.register(ctx.userId, `task:${taskId}`, TASK_SUBSCRIPTION_TTL_MS);
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
