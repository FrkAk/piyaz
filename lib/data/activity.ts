import "server-only";

import { activityEvents } from "@/lib/db/schema";
import type { Tx } from "@/lib/db/rls";
import type { ActorDescriptor } from "@/lib/auth/context";
import type { ActivityEventType } from "@/lib/types";

/** The three durable actor columns written onto every event row. */
export type ActorColumns = {
  actorUserId: string;
  source: "web" | "mcp" | "system";
  actorClientId: string | null;
};

/**
 * Derive the durable actor columns from a request's actor descriptor. Pure —
 * no DB read, never touches `neon_auth`. Display name/avatar/harness are
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
 * actor columns are derived from the descriptor (pure, no `neon_auth` read)
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
