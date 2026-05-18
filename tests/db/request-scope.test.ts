import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AppDb, AuthDb, DbBundle } from "@/lib/db/_driver.node";
import { requestDbStore } from "@/lib/db/connection";
import {
  type PoolBuilders,
  withRequestDbCore,
} from "@/lib/db/request-scope.workers";

interface RecordedCtx {
  waitUntil: ReturnType<typeof mock>;
  awaited: () => Promise<unknown[]>;
}

/**
 * Build a stub `ExecutionContext` that records every `waitUntil` argument.
 * The `awaited()` accessor settles each captured promise so individual
 * tests can assert on lifecycle errors without keeping a dangling
 * rejection.
 *
 * @returns Recording context plus a helper that drains the captured promises.
 */
function makeRecordingCtx(): RecordedCtx {
  const captured: Promise<unknown>[] = [];
  const waitUntil = mock((p: Promise<unknown>) => {
    captured.push(p);
  });
  return {
    waitUntil,
    awaited: () => Promise.all(captured.map((p) => p.catch((err) => err))),
  };
}

interface StubPool {
  end: ReturnType<typeof mock>;
}

/**
 * Build a `PoolBuilders` triple whose `db` handles are sentinel objects
 * and whose `pool.end()` implementations are configurable per role.
 *
 * @param ends - Optional per-role overrides for `pool.end()`.
 * @returns Builder triple plus references to the underlying mocks.
 */
function makeBuilders(ends?: {
  app?: () => Promise<unknown>;
  auth?: () => Promise<unknown>;
  service?: () => Promise<unknown>;
}): {
  builders: PoolBuilders;
  pools: { app: StubPool; auth: StubPool; service: StubPool };
  sentinels: { app: object; auth: object; service: object };
} {
  const appPool: StubPool = {
    end: mock(ends?.app ?? (async () => undefined)),
  };
  const authPool: StubPool = {
    end: mock(ends?.auth ?? (async () => undefined)),
  };
  const servicePool: StubPool = {
    end: mock(ends?.service ?? (async () => undefined)),
  };

  const appSentinel = { role: "app" };
  const authSentinel = { role: "auth" };
  const serviceSentinel = { role: "service" };

  const builders: PoolBuilders = {
    buildAppPool: () =>
      ({
        pool: appPool,
        db: appSentinel as unknown as AppDb,
      }) as DbBundle<AppDb>,
    buildAuthPool: () =>
      ({
        pool: authPool,
        db: authSentinel as unknown as AuthDb,
      }) as DbBundle<AuthDb>,
    buildServicePool: () =>
      ({
        pool: servicePool,
        db: serviceSentinel as unknown as AppDb,
      }) as DbBundle<AppDb>,
  };

  return {
    builders,
    pools: { app: appPool, auth: authPool, service: servicePool },
    sentinels: {
      app: appSentinel,
      auth: authSentinel,
      service: serviceSentinel,
    },
  };
}

describe("withRequestDbCore", () => {
  let unhandled: Array<{ reason: unknown }>;
  let originalHandler: NodeJS.UnhandledRejectionListener[];

  beforeEach(() => {
    unhandled = [];
    originalHandler = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", (reason) => {
      unhandled.push({ reason });
    });
  });

  afterEach(() => {
    process.removeAllListeners("unhandledRejection");
    for (const handler of originalHandler) {
      process.on("unhandledRejection", handler);
    }
  });

  it("seeds the ALS frame with the three role clients", async () => {
    const ctx = makeRecordingCtx();
    const { builders, sentinels } = makeBuilders();

    await withRequestDbCore(ctx, builders, async () => {
      const store = requestDbStore.getStore();
      expect(store).toBeDefined();
      expect(store?.appDb).toBe(sentinels.app as never);
      expect(store?.authDb).toBe(sentinels.auth as never);
      expect(store?.serviceRoleDb).toBe(sentinels.service as never);
    });
  });

  it("schedules pool.end() via ctx.waitUntil exactly three times on success", async () => {
    const ctx = makeRecordingCtx();
    const { builders, pools } = makeBuilders();

    await withRequestDbCore(ctx, builders, async () => "ok");

    expect(ctx.waitUntil).toHaveBeenCalledTimes(3);
    await ctx.awaited();
    expect(pools.app.end).toHaveBeenCalledTimes(1);
    expect(pools.auth.end).toHaveBeenCalledTimes(1);
    expect(pools.service.end).toHaveBeenCalledTimes(1);
  });

  it("propagates fn() errors and still closes every pool", async () => {
    const ctx = makeRecordingCtx();
    const { builders, pools } = makeBuilders();
    const sentinelError = new Error("handler exploded");

    await expect(
      withRequestDbCore(ctx, builders, async () => {
        throw sentinelError;
      }),
    ).rejects.toBe(sentinelError);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(3);
    await ctx.awaited();
    expect(pools.app.end).toHaveBeenCalledTimes(1);
    expect(pools.auth.end).toHaveBeenCalledTimes(1);
    expect(pools.service.end).toHaveBeenCalledTimes(1);
  });

  it("swallows pool.end() rejections into console.error without unhandled rejections", async () => {
    const ctx = makeRecordingCtx();
    const { builders } = makeBuilders({
      app: async () => {
        throw new Error("socket teardown failed");
      },
    });

    const errorSpy = mock((..._args: unknown[]) => undefined);
    const originalError = console.error;
    console.error = errorSpy as unknown as typeof console.error;

    try {
      await withRequestDbCore(ctx, builders, async () => "ok");
      await ctx.awaited();
    } finally {
      console.error = originalError;
    }

    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toHaveLength(0);
    const calls = errorSpy.mock.calls;
    expect(
      calls.some(
        (args) =>
          typeof args[0] === "string" &&
          (args[0] as string).startsWith("[db] app pool end failed"),
      ),
    ).toBe(true);
  });
});
