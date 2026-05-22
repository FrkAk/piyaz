import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Cloudflare branch of `getScopedOrGlobal` in `lib/db/connection.ts`.
 *
 * Since the B2 refactor (MYMR-165 follow-up), the Workers path uses the
 * same `globalThis`-cached singleton as self-host; the Pool is a
 * per-isolate singleton with `maxUses: 1` connections. The legacy
 * per-request ALS auto-seed has been removed.
 *
 * `requestDbStore.run(...)` still wins when an explicit ALS frame is
 * active — used by tests that inject sentinels and by any future
 * background callers that want explicit scoping.
 */

mock.module("@/lib/db/request-scope", () => ({
  withRequestDb: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

describe("getScopedOrGlobal on Cloudflare", () => {
  let originalTarget: string | undefined;

  beforeEach(() => {
    originalTarget = process.env.DEPLOY_TARGET;
    process.env.DEPLOY_TARGET = "cloudflare";
    delete (globalThis as { __mymirAppDb?: unknown }).__mymirAppDb;
    delete (globalThis as { __mymirAuthDb?: unknown }).__mymirAuthDb;
    delete (globalThis as { __mymirServiceRoleDb?: unknown })
      .__mymirServiceRoleDb;
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
