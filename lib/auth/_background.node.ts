import "server-only";

/**
 * Detach a Better Auth background task on the Node runtime.
 *
 * @param promise - Task promise that may finish after the response.
 */
export function enrollAuthBackgroundTask(promise: Promise<unknown>): void {
  void promise;
}
