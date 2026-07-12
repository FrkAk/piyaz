import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, assertTaskAccess } from "@/lib/auth/authorization";
import { getProjectMaxUpdatedAt } from "@/lib/data/project";
import {
  RecordNotTerminalError,
  resolveAgentBundleData,
  resolvePlanningData,
  resolveRecordData,
  resolveReviewData,
  resolveWorkingData,
} from "@/lib/context/_core/bundle";
import { buildAgentContextParts } from "@/lib/context/_core/agent";
import { buildPlanningContextParts } from "@/lib/context/_core/planning";
import { buildRecordContextParts } from "@/lib/context/_core/record";
import { buildReviewContextParts } from "@/lib/context/_core/review";
import {
  buildWorkingContextFrom,
  formatWorkingContextParts,
} from "@/lib/context/_core/working";
import {
  BUNDLE_KINDS,
  type BundleKind,
  type BundlePart,
} from "@/lib/context/parts";
import { isTerminalStatus } from "@/lib/types";
import { conditionalRespond, etagMatches } from "@/lib/api/conditional";
import { internalError } from "@/lib/api/error";
import { error } from "@/lib/api/response";
import { consentGateResponse } from "@/lib/auth/consent";

/** 400 body shared by the gate pre-check and the resolver's terminal assert. */
const RECORD_REQUIRES_TERMINAL =
  "record bundle requires a done or cancelled task";

/**
 * Narrow a raw query-param value to a {@link BundleKind}.
 *
 * @param value - Raw `?bundle=` value.
 * @returns Whether the value is a known bundle kind.
 */
function isBundleKind(value: string | null): value is BundleKind {
  return value !== null && (BUNDLE_KINDS as readonly string[]).includes(value);
}

/**
 * Resolve and assemble one bundle's structured sections. Each kind pays only
 * for the data its builder renders — one task read at the kind's column
 * projection, plus the dependency traversal only for closure-backed kinds —
 * resolved through stateless read batches.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @param kind - Bundle kind to build.
 * @returns Ordered bundle parts.
 * @throws ForbiddenError When the caller cannot access the task.
 */
async function buildSections(
  userId: string,
  taskId: string,
  kind: BundleKind,
): Promise<BundlePart[]> {
  switch (kind) {
    case "working":
      return formatWorkingContextParts(
        buildWorkingContextFrom(await resolveWorkingData(userId, taskId)),
      );
    case "planning":
      return buildPlanningContextParts(
        await resolvePlanningData(userId, taskId),
      );
    case "agent": {
      const resolved = await resolveAgentBundleData(userId, taskId);
      return resolved.kind === "record"
        ? buildRecordContextParts(resolved.data)
        : buildAgentContextParts(resolved.data);
    }
    case "review":
      return buildReviewContextParts(await resolveReviewData(userId, taskId));
    case "record":
      return buildRecordContextParts(await resolveRecordData(userId, taskId));
  }
}

/**
 * Conditional handler for `GET` and `HEAD` on the per-task bundle sections
 * payload. `?bundle=<kind>` selects exactly one bundle; the response is
 * `{ sections }` where each section is `{ id, heading, markdown }` and the
 * MD view is the deterministic join. Missing/unknown kind → 400;
 * `bundle=record` on a non-terminal task → 400 (a fast pre-check on the
 * access-gate status, re-asserted by the resolver against the row it
 * actually fetched so a concurrent reopen cannot race a stale record).
 * `bundle=agent` delegates to the same status dispatch the MCP
 * `depth='agent'` path uses — `done`/`cancelled` rows resolve the
 * retrospective record bundle, decided by the fetched row itself.
 *
 * The validator path reads only the slim access gate, so HEAD/304 never pay
 * for a full task. `Last-Modified` stays the project-max validator (see
 * {@link getProjectMaxUpdatedAt}); the query param gives each kind its own
 * client cache entry against the same validator.
 *
 * @param req - Incoming request.
 * @param taskId - Task UUID from the route params.
 * @returns 200 with `{ sections }`, 304, 400, 401, 404, or 500.
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
  if (!isBundleKind(kind)) {
    return error("Missing or unknown bundle kind", 400);
  }

  try {
    const gate = await assertTaskAccess(taskId, ctx);
    if (kind === "record" && !isTerminalStatus(gate.status)) {
      return error(RECORD_REQUIRES_TERMINAL, 400);
    }
    const max = await getProjectMaxUpdatedAt(ctx, gate.projectId, true);

    if (req.method === "HEAD" || etagMatches(req, max)) {
      return conditionalRespond(req, null, max);
    }

    const sections = await buildSections(ctx.userId, taskId, kind);
    return conditionalRespond(req, { sections }, max);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return error("Task not found", 404);
    }
    if (err instanceof RecordNotTerminalError) {
      return error(RECORD_REQUIRES_TERMINAL, 400);
    }
    return internalError("task-context", err);
  }
}

/**
 * GET handler — returns one bundle's structured sections for a task,
 * selected by the `?bundle=<kind>` query param.
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
 * HEAD handler — same auth + 304 logic as GET (including `?bundle=`
 * validation), never returns a body.
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
