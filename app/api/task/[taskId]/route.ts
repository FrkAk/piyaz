import { getAuthContext } from '@/lib/auth/context';
import { ForbiddenError, assertTaskAccess } from '@/lib/auth/authorization';
import { conditionalRespond, etagMatches } from '@/lib/api/conditional';
import { getProjectIdentifier } from '@/lib/data/project';
import { asIdentifier, composeTaskRef } from '@/lib/graph/identifier';
import { broker } from '@/lib/realtime/broker';
import { internalError } from '@/lib/api/error';
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
 * Auth + validator (`assertTaskAccess`) runs first so a 304 short-circuit
 * skips the second `projects.identifier` round-trip that the response
 * body needs for `taskRef`. Without that ordering every 304 still hits
 * the DB twice — for resources users re-select frequently this is the
 * common case. Broker subscription registration is also skipped on
 * HEAD/304 because both are cache probes, not "user is viewing" signals.
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
    const task = await assertTaskAccess(taskId, ctx);

    if (req.method === 'HEAD' || etagMatches(req, task.updatedAt)) {
      return conditionalRespond(req, null, task.updatedAt);
    }

    const identifier = await getProjectIdentifier(task.projectId);
    if (!identifier) {
      throw new Error(
        `Task ${task.id} references missing project ${task.projectId}`,
      );
    }
    const taskRef = composeTaskRef(
      asIdentifier(identifier),
      task.sequenceNumber,
    );

    broker.register(ctx.userId, `task:${taskId}`, TASK_SUBSCRIPTION_TTL_MS);
    return conditionalRespond(req, { ...task, taskRef }, task.updatedAt);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return error('Task not found', 404);
    }
    return internalError('task', err);
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
 * @returns Empty response with `ETag` header.
 */
export async function HEAD(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  return handle(req, taskId);
}
