import "server-only";

import { requireSession } from "@/lib/auth/session";

declare const authContextBrand: unique symbol;

/**
 * Authenticated request context. Holds the user identity. All graph-layer
 * mutations and queries take an `AuthContext` so authorization cannot be
 * skipped at the application layer; per-resource access is gated by a fresh
 * membership JOIN inside the data layer (see {@link assertProjectAccess}).
 *
 * Branded — only `getAuthContext` (web) and `makeAuthContext` (MCP) can mint
 * a value, so any function taking an `AuthContext` sees a value the auth
 * layer has actually verified. There is no "active team" field here: team
 * scope is decided per-call by the resource id (web/UI) or by an explicit
 * `organizationId` arg (MCP create); both paths re-verify membership on
 * every request.
 */
/** Durable identity keys behind a request; display is resolved at read time. */
export type ActorDescriptor =
  | { source: "web"; userId: string }
  | { source: "mcp"; userId: string; clientId: string | null }
  | { source: "system"; userId: string };

export type AuthContext = {
  readonly userId: string;
  readonly actor: ActorDescriptor;
  readonly [authContextBrand]: true;
};

/**
 * Mint an `AuthContext` from already-verified credentials. Only call from
 * code paths that have validated the principal (session, JWT). Application
 * code should depend on `AuthContext` values handed in, not construct them.
 * @param userId - Verified user id (e.g. `session.user.id`, JWT `sub`).
 * @param actor - Resolved actor descriptor; defaults to a `system` actor
 *   bound to `userId` for callers (tests, internal jobs) that do not carry
 *   surface identity.
 * @returns Branded auth context.
 */
export function makeAuthContext(
  userId: string,
  actor: ActorDescriptor = { source: "system", userId },
): AuthContext {
  return { userId, actor } as unknown as AuthContext;
}

/**
 * Resolve the current request's auth context from the Better Auth session.
 * Does NOT enforce team membership — callers that need a team scope should
 * supply or look up the target org themselves and let the data layer's
 * membership JOIN do the gating.
 *
 * @returns Branded auth context with the verified user id.
 * @throws Error from {@link requireSession} when not authenticated.
 */
export async function getAuthContext(): Promise<AuthContext> {
  const session = await requireSession();
  return makeAuthContext(session.user.id, {
    source: "web",
    userId: session.user.id,
  });
}
