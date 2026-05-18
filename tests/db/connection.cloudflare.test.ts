import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Cloudflare branch of `getScopedOrGlobal` in `lib/db/connection.ts`. The
 * proxy must delegate to `autoSeedRequestDb` (from the `request-scope`
 * alias indirection) when `DEPLOY_TARGET === "cloudflare"` and no ALS
 * frame is active. The seeder is mocked at module-import time so this
 * file does not need a live Cloudflare execution context.
 */

const seedCalls: number[] = [];

mock.module("@/lib/db/request-scope", () => ({
  withRequestDb: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  autoSeedRequestDb: () => {
    seedCalls.push(seedCalls.length);
    const scope = {
      appDb: { marker: "auto-app" },
      authDb: { marker: "auto-auth" },
      serviceRoleDb: { marker: "auto-service" },
    };
    return scope as never;
  },
}));

describe("getScopedOrGlobal on Cloudflare", () => {
  let originalTarget: string | undefined;

  beforeEach(() => {
    originalTarget = process.env.DEPLOY_TARGET;
    process.env.DEPLOY_TARGET = "cloudflare";
    seedCalls.length = 0;
  });

  afterEach(() => {
    if (originalTarget !== undefined) {
      process.env.DEPLOY_TARGET = originalTarget;
    } else {
      delete process.env.DEPLOY_TARGET;
    }
  });

  it("auto-seeds via autoSeedRequestDb when no ALS frame is active", async () => {
    const { appDb, authDb, serviceRoleDb } = await import(
      "@/lib/db/connection"
    );

    expect((appDb as unknown as { marker: string }).marker).toBe("auto-app");
    expect((authDb as unknown as { marker: string }).marker).toBe("auto-auth");
    expect((serviceRoleDb as unknown as { marker: string }).marker).toBe(
      "auto-service",
    );
    expect(seedCalls.length).toBeGreaterThan(0);
  });

  it("does not invoke autoSeedRequestDb when an ALS frame is already active", async () => {
    const { appDb, requestDbStore } = await import("@/lib/db/connection");
    seedCalls.length = 0;

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

    expect(seedCalls.length).toBe(0);
  });
});
