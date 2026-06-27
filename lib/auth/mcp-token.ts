import "server-only";

import { z } from "zod/v4";
import { makeAuthContext, type AuthContext } from "@/lib/auth/context";

/**
 * Claims required from a verified MCP access token. `sub` is the user id;
 * `azp` is the OAuth client (agent harness) id. `@better-auth/oauth-provider`
 * stamps `azp` on every JWT access token it issues, so requiring it here
 * rejects only anomalous tokens and guarantees every MCP-attributed write
 * records which harness made it (no silent unattributed agent actions).
 */
export const accessTokenClaimsSchema = z.looseObject({
  sub: z.uuid(),
  azp: z.string().min(1),
});

/**
 * Map a verified JWT payload to an MCP `AuthContext`. Team scope is resolved
 * per call in the data layer via membership JOINs, never via a token-bound
 * active-org claim.
 *
 * @param payload - Decoded, signature-verified JWT payload.
 * @returns The MCP auth context, or null when a required claim is missing or
 *   malformed (the caller maps null to 401).
 */
export function authContextFromPayload(payload: unknown): AuthContext | null {
  const parsed = accessTokenClaimsSchema.safeParse(payload);
  if (!parsed.success) return null;
  return makeAuthContext(parsed.data.sub, {
    source: "mcp",
    userId: parsed.data.sub,
    clientId: parsed.data.azp,
  });
}
