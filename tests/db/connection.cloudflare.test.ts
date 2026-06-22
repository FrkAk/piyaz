import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Cloudflare branch of `getScopedOrGlobal` in `lib/db/connection.ts`.
 *
 * Since MYMR-216, Workers builds resolve DB clients exclusively from the
 * per-request ALS frame seeded by `withRequestDb`; unscoped access throws
 * outside development (covered by `tests/db/request-scope.workers.test.ts`).
 * The frame always wins when active — used by tests that inject sentinels
 * and by the production worker entry.
 */

mock.module("@/lib/db/request-scope", () => ({
  requiresRequestScope: false,
  withRequestDb: async <T>(fn: () => Promise<T>) => ({
    result: await fn(),
    teardown: async () => {},
  }),
}));

describe("getScopedOrGlobal on Cloudflare", () => {
  let originalTarget: string | undefined;

  beforeEach(() => {
    originalTarget = process.env.DEPLOY_TARGET;
    process.env.DEPLOY_TARGET = "cloudflare";
    delete (globalThis as { __piyazAppDb?: unknown }).__piyazAppDb;
    delete (globalThis as { __piyazAuthDb?: unknown }).__piyazAuthDb;
    delete (globalThis as { __piyazServiceRoleDb?: unknown })
      .__piyazServiceRoleDb;
  });

  afterEach(() => {
    if (originalTarget !== undefined) {
      process.env.DEPLOY_TARGET = originalTarget;
    } else {
      delete process.env.DEPLOY_TARGET;
    }
  });

  it("resolves to the seeded scope when an ALS frame is active", async () => {
    const { appDb, requestDbStore } = await import("@/lib/db/connection");

    const sentinel = { marker: "explicit-app" };
    requestDbStore.run(
      {
        appDb: sentinel as never,
        authDb: { marker: "explicit-auth" } as never,
        serviceRoleDb: { marker: "explicit-service" } as never,
      },
      () => {
        expect((appDb as unknown as { marker: string }).marker).toBe(
          "explicit-app",
        );
      },
    );
  });
});
