import "server-only";

import type { ActorDescriptor } from "@/lib/auth/context";

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
