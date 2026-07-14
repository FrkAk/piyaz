import "server-only";

/**
 * Node / self-host floating-send enrollment.
 *
 * The webpack alias in `next.config.ts` resolves `lib/email/_defer` to this
 * sibling on non-Cloudflare builds. The Node runtime keeps pending promises
 * alive without registration, so enrollment is a no-op beyond detaching the
 * promise; callers attach their own `.catch` before enrolling.
 *
 * @param promise - The email send promise to detach from the response.
 */
export function enrollEmailSend(promise: Promise<unknown>): void {
  void promise;
}
