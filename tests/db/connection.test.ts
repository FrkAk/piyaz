import { test, expect, describe, it, beforeEach, afterEach } from "bun:test";
import type { AppUserConn, AuthDb, ServiceRoleConn } from "@/lib/db/connection";
import { requestDbStore } from "@/lib/db/connection";
import { superuserPool } from "@/tests/setup/global";

type GlobalCache = {
  __mymirAppDb?: unknown;
  __mymirAuthDb?: unknown;
  __mymirServiceRoleDb?: unknown;
};

test("container is reachable and migrations applied", async () => {
  const sql = superuserPool();
  try {
    const rows = await sql<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema IN ('public', 'neon_auth')
      ORDER BY table_name
    `;
    const names = rows.map((r) => r.name);
    expect(names).toContain("projects");
    expect(names).toContain("tasks");
    expect(names).toContain("user");
    expect(names).toContain("organization");
  } finally {
    await sql.end({ timeout: 5 });
  }
});

describe("connection.ts auth client", () => {
  let originalAuthUrl: string | undefined;
  let originalCache: unknown;

  beforeEach(() => {
    originalAuthUrl = process.env.DATABASE_AUTH_URL;
    originalCache = (globalThis as { __mymirAuthDb?: unknown }).__mymirAuthDb;
    delete process.env.DATABASE_AUTH_URL;
    (globalThis as { __mymirAuthDb?: unknown }).__mymirAuthDb = undefined;
  });

  afterEach(() => {
    if (originalAuthUrl !== undefined) {
      process.env.DATABASE_AUTH_URL = originalAuthUrl;
    } else {
      delete process.env.DATABASE_AUTH_URL;
    }
    (globalThis as { __mymirAuthDb?: unknown }).__mymirAuthDb =
      originalCache as never;
  });

  it("throws when DATABASE_AUTH_URL is unset", async () => {
    const { authDb } = await import("@/lib/db/connection");
    expect(() => authDb.select).toThrow(/DATABASE_AUTH_URL is required/);
  });
});

describe("getScopedOrGlobal resolver", () => {
  let originalAppCache: unknown;
  let originalAuthCache: unknown;
  let originalServiceCache: unknown;
  let originalDatabaseUrl: string | undefined;

  beforeEach(() => {
    const g = globalThis as GlobalCache;
    originalAppCache = g.__mymirAppDb;
    originalAuthCache = g.__mymirAuthDb;
    originalServiceCache = g.__mymirServiceRoleDb;
    originalDatabaseUrl = process.env.DATABASE_URL;
    g.__mymirAppDb = undefined;
    g.__mymirAuthDb = undefined;
    g.__mymirServiceRoleDb = undefined;
  });

  afterEach(() => {
    const g = globalThis as GlobalCache;
    g.__mymirAppDb = originalAppCache as never;
    g.__mymirAuthDb = originalAuthCache as never;
    g.__mymirServiceRoleDb = originalServiceCache as never;
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it("returns the per-request bundle when an ALS frame is active", async () => {
    const { appDb, authDb, serviceRoleDb } = await import(
      "@/lib/db/connection"
    );
    const appSentinel = { marker: "app" } as unknown as AppUserConn;
    const authSentinel = { marker: "auth" } as unknown as AuthDb;
    const serviceSentinel = {
      marker: "service",
    } as unknown as ServiceRoleConn;

    requestDbStore.run(
      {
        appDb: appSentinel,
        authDb: authSentinel,
        serviceRoleDb: serviceSentinel,
      },
      () => {
        expect((appDb as unknown as { marker: string }).marker).toBe("app");
        expect((authDb as unknown as { marker: string }).marker).toBe("auth");
        expect((serviceRoleDb as unknown as { marker: string }).marker).toBe(
          "service",
        );
      },
    );
  });

  it("falls back to the globalThis cache when no ALS frame is active", async () => {
    const { appDb } = await import("@/lib/db/connection");
    const sentinel = { marker: "cached-app" };
    (globalThis as GlobalCache).__mymirAppDb = sentinel as never;

    expect((appDb as unknown as { marker: string }).marker).toBe("cached-app");
  });

  it("invokes the builder when cache is empty on self-host", async () => {
    delete process.env.DEPLOY_TARGET;
    process.env.DATABASE_URL = "postgres://invalid:invalid@127.0.0.1:1/none";
    (globalThis as GlobalCache).__mymirAppDb = undefined;

    const { appDb } = await import("@/lib/db/connection");

    expect(typeof (appDb as unknown as { select: unknown }).select).toBe(
      "function",
    );
    expect((globalThis as GlobalCache).__mymirAppDb).toBeDefined();
  });

  // TODO: cover the Cloudflare throw-on-missing-ALS-frame branch. Mutating
  // process.env.DEPLOY_TARGET = "cloudflare" mid-suite would race other
  // tests that load lib/db modules; see lib/db/connection.ts:getScopedOrGlobal
  // for the guarded branch.
});
