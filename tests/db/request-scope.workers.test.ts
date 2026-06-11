import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { neonConfig } from "@neondatabase/serverless";
import {
  buildAppPool,
  buildAuthPool,
  buildServicePool,
} from "@/lib/db/_driver.workers";
import { requestDbStore } from "@/lib/db/connection";

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

type GlobalCache = {
  __mymirAppDb?: unknown;
  __mymirAuthDb?: unknown;
  __mymirServiceRoleDb?: unknown;
};

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
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    Object.assign(process.env, DUMMY_URLS);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("returns a fresh Pool on every call", async () => {
    const first = buildAppPool();
    const second = buildAppPool();
    expect(first.pool).not.toBe(second.pool);
    expect(first.db).not.toBe(second.db);
    await first.pool.end();
    await second.pool.end();
  });

  it("builds pools without the lifecycle workaround options", async () => {
    const bundles = [buildAppPool(), buildAuthPool(), buildServicePool()];
    for (const bundle of bundles) {
      const { options } = bundle.pool as unknown as PoolInternals;
      expect(options.maxUses ?? Infinity).toBe(Infinity);
      expect(options.connectionTimeoutMillis ?? 0).toBe(0);
    }
    await Promise.all(bundles.map((bundle) => bundle.pool.end()));
  });

  it("keeps poolQueryViaFetch and drops the pipelineConnect override", () => {
    expect(neonConfig.poolQueryViaFetch).toBe(true);
    expect(neonConfig.pipelineConnect).not.toBe(false);
  });
});

describe("withRequestDb (workers)", () => {
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    Object.assign(process.env, DUMMY_URLS);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

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

  it("uses explicit worker binding URLs when process env is not populated", async () => {
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

  it("rejects incomplete explicit worker binding URLs", async () => {
    const { withRequestDb } = await import("@/lib/db/request-scope.workers");
    let ran = false;

    await expect(
      withRequestDb(
        async () => {
          ran = true;
        },
        { ...EXPLICIT_URLS, databaseAuthUrl: undefined },
      ),
    ).rejects.toThrow(/DATABASE_AUTH_URL/);
    expect(ran).toBe(false);
  });

  it("teardown ends all three pools exactly once", async () => {
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
      expect(pool.connect()).rejects.toThrow(/after calling end/);
    }
    // The vendored pg BoundPool rejects a second end(); the memoized
    // teardown must absorb the repeat call instead of surfacing it.
    await outcome.teardown();
  });

  it("ends pools and rethrows when fn throws", async () => {
    const { withRequestDb } = await import("@/lib/db/request-scope.workers");
    let pools: PoolInternals[] = [];

    await expect(
      withRequestDb(async () => {
        const frame = requestDbStore.getStore();
        if (!frame) throw new Error("no frame");
        pools = [
          poolOf(frame.appDb),
          poolOf(frame.authDb),
          poolOf(frame.serviceRoleDb),
        ];
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(pools).toHaveLength(3);
    for (const pool of pools) {
      expect(pool.ended).toBe(true);
    }
  });
});

describe("connection proxies under DEPLOY_TARGET=cloudflare", () => {
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  let savedCaches: GlobalCache;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    Object.assign(process.env, DUMMY_URLS);
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
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    Object.assign(globalThis as GlobalCache, savedCaches);
  });

  it("throws on db access outside an active request frame", async () => {
    const { appDb } = await import("@/lib/db/connection");
    expect(() => appDb.select).toThrow(/withRequestDb/);
  });

  it("resolves from the frame when one is active", async () => {
    const { appDb } = await import("@/lib/db/connection");
    const sentinel = { marker: "scoped-app" };

    requestDbStore.run(
      {
        appDb: sentinel as never,
        authDb: sentinel as never,
        serviceRoleDb: sentinel as never,
      },
      () => {
        expect((appDb as unknown as { marker: string }).marker).toBe(
          "scoped-app",
        );
      },
    );
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
