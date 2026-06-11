import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { neonConfig } from "@neondatabase/serverless";
import {
  buildAppPool,
  buildAuthPool,
  buildServicePool,
} from "@/lib/db/_driver.workers";
import { requestDbStore, deferRequestWork } from "@/lib/db/request-store";

/**
 * Structural view of the Neon Pool internals the assertions below read.
 * `options` / `ended` are runtime properties of the vendored pg BoundPool
 * inside `@neondatabase/serverless`; they are not in the public types.
 */
type PoolInternals = {
  options: { maxUses?: number; connectionTimeoutMillis?: number };
  ended?: boolean;
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
};

/** Dummy DSNs — `new NeonPool(...)` parses the string without any I/O. */
const DUMMY_URLS = {
  DATABASE_URL: "postgres://app:app@db.test.invalid:5432/mymir",
  DATABASE_AUTH_URL: "postgres://auth:auth@db.test.invalid:5432/mymir",
  DATABASE_SERVICE_ROLE_URL: "postgres://svc:svc@db.test.invalid:5432/mymir",
} as const;

const EXPLICIT_URLS = {
  databaseUrl: "postgres://explicit-app:app@db.test.invalid:5432/mymir",
  databaseAuthUrl: "postgres://explicit-auth:auth@db.test.invalid:5432/mymir",
  databaseServiceRoleUrl:
    "postgres://explicit-svc:svc@db.test.invalid:5432/mymir",
} as const;

const ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_AUTH_URL",
  "DATABASE_SERVICE_ROLE_URL",
  "DEPLOY_TARGET",
] as const;

/**
 * Register beforeEach/afterEach hooks that snapshot and restore the DB env
 * keys, seeding {@link DUMMY_URLS}. Call once per describe block.
 */
function useSavedDbEnv(): void {
  let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    Object.assign(process.env, DUMMY_URLS);
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

/**
 * Extract the underlying Neon Pool from a Drizzle client via the public
 * `$client` accessor (typed loosely because the shared `AppDb` alias is
 * pinned to the postgres-js driver shape).
 *
 * @param dbClient - Drizzle client built by the workers driver.
 * @returns The pool internals view for assertions.
 */
function poolOf(dbClient: unknown): PoolInternals {
  return (dbClient as { $client: PoolInternals }).$client;
}

describe("workers driver pool factories", () => {
  useSavedDbEnv();

  it("returns a fresh Pool on every call", async () => {
    const first = buildAppPool();
    const second = buildAppPool();
    expect(first.pool).not.toBe(second.pool);
    expect(first.db).not.toBe(second.db);
    await first.pool.end();
    await second.pool.end();
  });

  it("drops the single-use workaround but keeps a bounded connect", async () => {
    const bundles = [buildAppPool(), buildAuthPool(), buildServicePool()];
    for (const bundle of bundles) {
      const { options } = bundle.pool as unknown as PoolInternals;
      expect(options.maxUses ?? Infinity).toBe(Infinity);
      expect(options.connectionTimeoutMillis).toBe(10_000);
    }
    await Promise.all(bundles.map((bundle) => bundle.pool.end()));
  });

  it("keeps poolQueryViaFetch and the pipelineConnect guard", () => {
    expect(neonConfig.poolQueryViaFetch).toBe(true);
    expect(neonConfig.pipelineConnect).toBe(false);
  });
});

describe("withRequestDb (workers)", () => {
  useSavedDbEnv();

  it("runs fn inside an ALS frame and returns result plus teardown", async () => {
    const { withRequestDb } = await import("@/lib/db/request-scope.workers");
    let frameSeen = false;

    const outcome = await withRequestDb(async () => {
      const frame = requestDbStore.getStore();
      frameSeen = frame !== undefined;
      expect(typeof frame?.appDb.select).toBe("function");
      expect(typeof frame?.authDb.select).toBe("function");
      expect(typeof frame?.serviceRoleDb.select).toBe("function");
      return "rendered";
    });

    expect(frameSeen).toBe(true);
    expect(outcome.result).toBe("rendered");
    expect(typeof outcome.teardown).toBe("function");
    expect(requestDbStore.getStore()).toBeUndefined();
    await outcome.teardown();
  });

  it("builds each role's pool lazily on first access", async () => {
    const { withRequestDb } = await import("@/lib/db/request-scope.workers");
    delete process.env.DATABASE_AUTH_URL;
    delete process.env.DATABASE_SERVICE_ROLE_URL;

    const outcome = await withRequestDb(async () => {
      const frame = requestDbStore.getStore();
      if (!frame) throw new Error("no frame");
      expect(typeof frame.appDb.select).toBe("function");
      return "app-only";
    });

    expect(outcome.result).toBe("app-only");
    await outcome.teardown();
  });

  it("throws the role's own error on first access when its URL is missing", async () => {
    const { withRequestDb } = await import("@/lib/db/request-scope.workers");
    delete process.env.DATABASE_AUTH_URL;

    await expect(
      withRequestDb(async () => {
        const frame = requestDbStore.getStore();
        return frame?.authDb.select;
      }),
    ).rejects.toThrow(/DATABASE_AUTH_URL/);
  });

  it("uses explicit worker binding URLs over process env", async () => {
    const { withRequestDb } = await import("@/lib/db/request-scope.workers");
    for (const key of ENV_KEYS) delete process.env[key];

    const outcome = await withRequestDb(async () => {
      const frame = requestDbStore.getStore();
      if (!frame) throw new Error("no frame");
      expect(poolOf(frame.appDb).options).toBeDefined();
      expect(poolOf(frame.authDb).options).toBeDefined();
      expect(poolOf(frame.serviceRoleDb).options).toBeDefined();
      return "rendered";
    }, EXPLICIT_URLS);

    expect(outcome.result).toBe("rendered");
    await outcome.teardown();
  });

  it("teardown ends every built pool exactly once", async () => {
    const { withRequestDb } = await import("@/lib/db/request-scope.workers");
    let pools: PoolInternals[] = [];

    const outcome = await withRequestDb(async () => {
      const frame = requestDbStore.getStore();
      if (!frame) throw new Error("no frame");
      pools = [
        poolOf(frame.appDb),
        poolOf(frame.authDb),
        poolOf(frame.serviceRoleDb),
      ];
    });

    await outcome.teardown();
    for (const pool of pools) {
      expect(pool.ended).toBe(true);
      await expect(pool.connect()).rejects.toThrow(/after calling end/);
    }
    // The vendored pg BoundPool rejects a second end(); the memoized
    // teardown must absorb the repeat call instead of surfacing it.
    await outcome.teardown();
  });

  it("teardown resolves even when a pool was already ended", async () => {
    const { withRequestDb } = await import("@/lib/db/request-scope.workers");

    const outcome = await withRequestDb(async () => {
      const frame = requestDbStore.getStore();
      if (!frame) throw new Error("no frame");
      await poolOf(frame.appDb).end();
    });

    await outcome.teardown();
  });

  it("rethrows the original error when fn throws after a pool failure", async () => {
    const { withRequestDb } = await import("@/lib/db/request-scope.workers");
    let pools: PoolInternals[] = [];

    await expect(
      withRequestDb(async () => {
        const frame = requestDbStore.getStore();
        if (!frame) throw new Error("no frame");
        pools = [poolOf(frame.appDb), poolOf(frame.authDb)];
        await pools[0].end();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(pools).toHaveLength(2);
    for (const pool of pools) {
      expect(pool.ended).toBe(true);
    }
  });

  it("settles deferred request work before ending pools", async () => {
    const { withRequestDb } = await import("@/lib/db/request-scope.workers");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pool: PoolInternals | undefined;

    const outcome = await withRequestDb(async () => {
      const frame = requestDbStore.getStore();
      if (!frame) throw new Error("no frame");
      pool = poolOf(frame.appDb);
      deferRequestWork(
        gate.then(() => {
          order.push("deferred");
        }),
      );
    });

    const teardownDone = outcome.teardown().then(() => {
      order.push("teardown");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    expect(pool?.ended).not.toBe(true);

    release();
    await teardownDone;
    expect(order).toEqual(["deferred", "teardown"]);
    expect(pool?.ended).toBe(true);
  });

  it("deferRequestWork is a no-op without an active frame", () => {
    expect(requestDbStore.getStore()).toBeUndefined();
    deferRequestWork(Promise.resolve());
  });
});

describe("connection proxies on the Workers target", () => {
  useSavedDbEnv();

  type GlobalCache = {
    __mymirAppDb?: unknown;
    __mymirAuthDb?: unknown;
    __mymirServiceRoleDb?: unknown;
  };
  let savedCaches: GlobalCache;

  beforeEach(() => {
    process.env.DEPLOY_TARGET = "cloudflare";
    const g = globalThis as GlobalCache;
    savedCaches = {
      __mymirAppDb: g.__mymirAppDb,
      __mymirAuthDb: g.__mymirAuthDb,
      __mymirServiceRoleDb: g.__mymirServiceRoleDb,
    };
    g.__mymirAppDb = undefined;
    g.__mymirAuthDb = undefined;
    g.__mymirServiceRoleDb = undefined;
  });

  afterEach(() => {
    Object.assign(globalThis as GlobalCache, savedCaches);
  });

  it("throws on db access outside an active request frame", async () => {
    const { appDb } = await import("@/lib/db/connection");
    expect(() => appDb.select).toThrow(/withRequestDb/);
  });

  it("falls back to the singleton in development (next dev)", async () => {
    const { appDb } = await import("@/lib/db/connection");
    const savedNodeEnv = process.env.NODE_ENV;
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "development",
      configurable: true,
    });
    try {
      expect(typeof (appDb as unknown as { select: unknown }).select).toBe(
        "function",
      );
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: savedNodeEnv,
        configurable: true,
      });
    }
  });
});

describe("scheduleRequestDbTeardown", () => {
  /**
   * Capture-style waitUntil stub mirroring `ctx.waitUntil` — records the
   * promise so the test can await background completion deterministically.
   *
   * @returns The recorder plus the captured promise accessor.
   */
  function makeWaitUntil() {
    let captured: Promise<unknown> | undefined;
    return {
      waitUntil: (p: Promise<unknown>) => {
        captured = p;
      },
      flush: async () => {
        await captured;
      },
    };
  }

  it("tears down immediately for null-body responses", async () => {
    const { scheduleRequestDbTeardown } = await import(
      "@/lib/db/request-scope.workers"
    );
    let calls = 0;
    const { waitUntil, flush } = makeWaitUntil();
    const response = new Response(null, { status: 204 });

    const wrapped = scheduleRequestDbTeardown(
      response,
      async () => {
        calls += 1;
      },
      waitUntil,
    );

    expect(wrapped).toBe(response);
    await flush();
    expect(calls).toBe(1);
  });

  it("defers teardown until the source body finishes streaming", async () => {
    const { scheduleRequestDbTeardown } = await import(
      "@/lib/db/request-scope.workers"
    );
    let calls = 0;
    const { waitUntil, flush } = makeWaitUntil();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        await gate;
        controller.close();
      },
    });

    const wrapped = scheduleRequestDbTeardown(
      new Response(source, { status: 200 }),
      async () => {
        calls += 1;
      },
      waitUntil,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(0);

    release();
    expect(await wrapped.text()).toBe("hello");
    await flush();
    expect(calls).toBe(1);
  });

  it("runs teardown when the consumer cancels mid-stream", async () => {
    const { scheduleRequestDbTeardown } = await import(
      "@/lib/db/request-scope.workers"
    );
    let calls = 0;
    const { waitUntil, flush } = makeWaitUntil();

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    });

    const wrapped = scheduleRequestDbTeardown(
      new Response(source, { status: 200 }),
      async () => {
        calls += 1;
      },
      waitUntil,
    );

    await wrapped.body?.cancel();
    await flush();
    expect(calls).toBe(1);
  });

  it("passes WebSocket upgrade responses through untouched", async () => {
    const { scheduleRequestDbTeardown } = await import(
      "@/lib/db/request-scope.workers"
    );
    let calls = 0;
    const { waitUntil, flush } = makeWaitUntil();
    const upgrade = {
      status: 101,
      webSocket: {},
      body: null,
    } as unknown as Response;

    const wrapped = scheduleRequestDbTeardown(
      upgrade,
      async () => {
        calls += 1;
      },
      waitUntil,
    );

    expect(wrapped).toBe(upgrade);
    await flush();
    expect(calls).toBe(1);
  });
});
