import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Enroll a Better Auth background task in the active Workers request context.
 *
 * @param promise - Task promise that must remain alive after the response.
 */
export function enrollAuthBackgroundTask(promise: Promise<unknown>): void {
  try {
    const { ctx } = getCloudflareContext({ async: false });
    ctx.waitUntil(promise);
  } catch {
    void promise;
  }
}
