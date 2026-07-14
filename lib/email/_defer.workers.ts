import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Cloudflare Workers floating-send enrollment.
 *
 * The webpack alias in `next.config.ts` resolves `lib/email/_defer` to this
 * sibling on `DEPLOY_TARGET=cloudflare` builds. Workers terminate pending I/O
 * when the Response returns, so a floating email send must be enrolled in the
 * request's `ctx.waitUntil` or it can be cancelled mid-flight. Mirrors
 * `lib/realtime/_broker.workers.ts`.
 *
 * Silently degrades when there is no active Cloudflare context (tests,
 * scheduled handlers); callers attach their own `.catch` before enrolling so
 * the promise never raises an unhandled rejection either way.
 *
 * @param promise - The email send promise to keep alive past the response.
 */
export function enrollEmailSend(promise: Promise<unknown>): void {
  try {
    const { ctx } = getCloudflareContext({ async: false });
    ctx.waitUntil(promise);
  } catch {
    /* no active CF context; the promise still resolves naturally */
  }
}
