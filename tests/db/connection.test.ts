import {
  test,
  expect,
  describe,
  it,
  beforeEach,
  afterEach,
} from "bun:test";
import postgres from "postgres";
import { getConnectionString } from "@/tests/setup/global";

test("container is reachable and migrations applied", async () => {
  const sql = postgres(getConnectionString(), { max: 1 });
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
