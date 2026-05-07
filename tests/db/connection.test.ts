import { test, expect } from "bun:test";
import postgres from "postgres";
import { getConnectionString } from "@/tests/setup/container";

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
