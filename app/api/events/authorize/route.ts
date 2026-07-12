import { getAuthContext } from "@/lib/auth/context";
import { listAccessibleProjectIds } from "@/lib/data/project";
import { ok, error } from "@/lib/api/response";
import { consentGateResponse } from "@/lib/auth/consent";

/**
 * Internal authorization probe for the Cloudflare realtime WebSocket upgrade.
 *
 * `worker-cf.ts` intercepts the browser's `Upgrade: websocket` request to
 * `/api/events`, sub-fetches this route to resolve the caller's identity and
 * accessible projects inside the Next/webpack bundle (where the Workers DB
 * driver alias is active and `auth` resolves), then opens the Durable Object
 * WebSocket itself. Resolving auth and the project list here is what keeps
 * the Node Postgres driver out of the wrangler-bundled worker entry.
 *
 * Returns only the authenticated caller's own user id and the project ids
 * they can access, so direct browser access leaks nothing. Self-host never
 * reaches this route — its realtime stays on the SSE `/api/events` handler.
 *
 * @returns 200 `{ userId, projectIds }` when authenticated, 401 otherwise.
 */
export async function GET(): Promise<Response> {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return error("Unauthorized", 401);
  }

  const gate = await consentGateResponse(ctx.userId);
  if (gate) return gate;
  const projectIds = await listAccessibleProjectIds(ctx);
  return ok({ userId: ctx.userId, projectIds });
}
