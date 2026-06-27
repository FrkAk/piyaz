import "server-only";

import { activityEvents } from "@/lib/db/schema";
import { withUserContextRead, type Tx } from "@/lib/db/rls";
import { normalizeExecuteResult } from "@/lib/db/raw";
import {
  taskActivityStmt,
  type ActivityCursor,
  type ActivityRawRow,
} from "@/lib/db/raw/fetch-task-activity";
import type { ActorDescriptor, AuthContext } from "@/lib/auth/context";
import type { ActivityEvent, ActivityEventType } from "@/lib/types";
import { isVerifiedOAuthClient } from "@/lib/auth/verified-oauth-clients";

/** The three durable actor columns written onto every event row. */
export type ActorColumns = {
  actorUserId: string;
  source: "web" | "mcp" | "system";
  actorClientId: string | null;
};

/**
 * Derive the durable actor columns from a request's actor descriptor. Pure —
 * no DB read, never touches `piyaz_auth`. Display name/avatar/harness are
 * resolved at read time via SECURITY DEFINER functions, never written here.
 *
 * @param actor - The request's resolved actor descriptor.
 * @returns The actor columns to persist on each event row.
 */
export function actorColumns(actor: ActorDescriptor): ActorColumns {
  return {
    actorUserId: actor.userId,
    source: actor.source,
    actorClientId: actor.source === "mcp" ? actor.clientId : null,
  };
}

/** Caller-supplied fields for a single event; actor + id + date are filled in. */
export type ActivityEventInput = {
  projectId: string;
  taskId: string | null;
  type: ActivityEventType;
  summary: string;
  targetRef?: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Insert activity events within an existing `app_user` transaction. Durable
 * actor columns are derived from the descriptor (pure, no `piyaz_auth` read)
 * and applied to every row. No-op for an empty list.
 *
 * @param tx - Active RLS-scoped transaction handle.
 * @param actor - The request's resolved actor descriptor.
 * @param events - Events to insert (constant-size rows).
 */
export async function insertActivityEvents(
  tx: Tx,
  actor: ActorDescriptor,
  events: ActivityEventInput[],
): Promise<void> {
  if (events.length === 0) return;
  const cols = actorColumns(actor);
  await tx.insert(activityEvents).values(
    events.map((e) => ({
      projectId: e.projectId,
      taskId: e.taskId,
      type: e.type,
      actorUserId: cols.actorUserId,
      source: cols.source,
      actorClientId: cols.actorClientId,
      summary: e.summary,
      targetRef: e.targetRef ?? null,
      metadata: e.metadata ?? null,
    })),
  );
}

/** Minimal criterion shape needed to diff. */
type CriterionLike = { id: string; text: string; checked: boolean };
/** Minimal decision shape needed to diff. */
type DecisionLike = { id: string; text: string };

/**
 * Diff acceptance criteria into add/remove/check/uncheck events.
 *
 * @param projectId - Owning project id.
 * @param taskId - Task id.
 * @param before - Criteria prior to the write.
 * @param after - Criteria after the write.
 * @returns Discrete events.
 */
export function diffCriteria(
  projectId: string,
  taskId: string,
  before: CriterionLike[],
  after: CriterionLike[],
): ActivityEventInput[] {
  const events: ActivityEventInput[] = [];
  const base = { projectId, taskId };
  const beforeById = new Map(before.map((c) => [c.id, c]));
  const afterById = new Map(after.map((c) => [c.id, c]));
  for (const c of after) {
    const prev = beforeById.get(c.id);
    if (!prev) {
      events.push({
        ...base,
        type: "criterion_added",
        summary: `added criterion "${c.text}"`,
        targetRef: c.id,
      });
      continue;
    }
    if (prev.text !== c.text) {
      events.push({
        ...base,
        type: "criterion_edited",
        summary: `edited criterion "${c.text}"`,
        targetRef: c.id,
      });
    }
    if (prev.checked !== c.checked) {
      events.push({
        ...base,
        type: c.checked ? "criterion_checked" : "criterion_unchecked",
        summary: `${c.checked ? "checked" : "unchecked"} "${c.text}"`,
        targetRef: c.id,
      });
    }
  }
  for (const c of before) {
    if (!afterById.has(c.id)) {
      events.push({
        ...base,
        type: "criterion_removed",
        summary: `removed criterion "${c.text}"`,
        targetRef: c.id,
      });
    }
  }
  return events;
}

/**
 * Diff decisions into add/remove events.
 *
 * @param projectId - Owning project id.
 * @param taskId - Task id.
 * @param before - Decisions prior to the write.
 * @param after - Decisions after the write.
 * @returns Discrete events.
 */
export function diffDecisions(
  projectId: string,
  taskId: string,
  before: DecisionLike[],
  after: DecisionLike[],
): ActivityEventInput[] {
  const events: ActivityEventInput[] = [];
  const base = { projectId, taskId };
  const beforeById = new Map(before.map((d) => [d.id, d]));
  const afterIds = new Set(after.map((d) => d.id));
  for (const d of after) {
    const prev = beforeById.get(d.id);
    if (!prev) {
      events.push({
        ...base,
        type: "decision_added",
        summary: `recorded decision "${d.text}"`,
        targetRef: d.id,
      });
    } else if (prev.text !== d.text) {
      events.push({
        ...base,
        type: "decision_edited",
        summary: `edited decision "${d.text}"`,
        targetRef: d.id,
      });
    }
  }
  for (const d of before) {
    if (!afterIds.has(d.id)) {
      events.push({
        ...base,
        type: "decision_removed",
        summary: `removed decision "${d.text}"`,
        targetRef: d.id,
      });
    }
  }
  return events;
}

/**
 * Diff assignee id sets into add/remove events.
 *
 * @param projectId - Owning project id.
 * @param taskId - Task id.
 * @param before - Assignee user ids prior to the write.
 * @param after - Assignee user ids after the write.
 * @returns Discrete events.
 */
export function diffAssignees(
  projectId: string,
  taskId: string,
  before: string[],
  after: string[],
): ActivityEventInput[] {
  const events: ActivityEventInput[] = [];
  const base = { projectId, taskId };
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  for (const id of after) {
    if (!beforeSet.has(id))
      events.push({
        ...base,
        type: "assignee_added",
        summary: "added an assignee",
        targetRef: id,
      });
  }
  for (const id of before) {
    if (!afterSet.has(id))
      events.push({
        ...base,
        type: "assignee_removed",
        summary: "removed an assignee",
        targetRef: id,
      });
  }
  return events;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Canonical UUID shape; guards the cursor id before it reaches a `::uuid` cast. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encode a keyset cursor from the last row of a page. `createdAt` is the
 * microsecond-precision ISO text (`created_at_cursor`), stored verbatim so the
 * seek literal matches the stored timestamp exactly.
 *
 * @param createdAt - Microsecond-precision ISO timestamp text.
 * @param id - Row id (tie-break).
 * @returns Opaque base64url cursor.
 */
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString("base64url");
}

/**
 * Decode a keyset cursor, preserving the timestamp's full precision. Returns
 * null on malformed input (callers treat that as the first page).
 *
 * @param cursor - Opaque base64url cursor from the client.
 * @returns The decoded keyset position, or null when malformed.
 */
function decodeCursor(cursor: string): ActivityCursor | null {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url")
      .toString("utf8")
      .split("|");
    if (!iso || !id || Number.isNaN(new Date(iso).getTime())) return null;
    if (!UUID_RE.test(id)) return null;
    return { createdAt: iso, id };
  } catch {
    return null;
  }
}

/** Coerce a driver timestamp (Date or ISO string) to a Date. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Map a raw page row to the API read model. Identity is already hydrated by
 * the SDF join (null when the actor cannot be resolved).
 *
 * @param r - Raw event row.
 * @returns The hydrated read model.
 */
function toActivityEvent(r: ActivityRawRow): ActivityEvent {
  return {
    id: r.id,
    projectId: r.project_id,
    taskId: r.task_id,
    type: r.type,
    createdAt: toDate(r.created_at).toISOString(),
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    actorAvatar: r.actor_image,
    source: r.source,
    agent: r.agent_name,
    agentVerified:
      r.actor_client_id != null && isVerifiedOAuthClient(r.actor_client_id),
    summary: r.summary,
    targetRef: r.target_ref,
    metadata: r.metadata,
  };
}

/**
 * List a task's activity newest-first, keyset-paginated. One RLS-scoped read:
 * the page and its read-time identity are resolved in a single statement that
 * joins the `activity_actors_visible` / `oauth_client_name` SECURITY DEFINER
 * functions — no `service_role`. A non-member transparently sees an empty page.
 *
 * @param ctx - Caller auth context.
 * @param taskId - Task whose events to read.
 * @param opts - `limit` (clamped to {@link MAX_LIMIT}) and an opaque `cursor`.
 * @returns A page of events plus the next cursor (null when exhausted).
 */
export async function listTaskActivity(
  ctx: AuthContext,
  taskId: string,
  opts: { cursor?: string; limit?: number },
): Promise<{ events: ActivityEvent[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;

  const [raw] = await withUserContextRead(ctx.userId, (read) => [
    taskActivityStmt(read, taskId, cur, limit + 1),
  ]);
  const rows = normalizeExecuteResult<ActivityRawRow>(raw);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  if (page.length === 0) return { events: [], nextCursor: null };

  const last = page[page.length - 1];
  return {
    events: page.map(toActivityEvent),
    nextCursor: hasMore ? encodeCursor(last.created_at_cursor, last.id) : null,
  };
}
