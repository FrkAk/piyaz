import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

/**
 * Apply `docker/init-auth.sql` (the neon_auth schema for self-hosted
 * Postgres) and `drizzle-kit push` (the public schema) against the
 * supplied connection string. Run once per container at globalSetup.
 *
 * @param url - Connection string for the target database.
 */
export async function applyMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    const initAuth = readFileSync(
      join(process.cwd(), "docker", "init-auth.sql"),
      "utf8",
    );
    await sql.unsafe(initAuth);
  } finally {
    await sql.end({ timeout: 5 });
  }

  const proc = Bun.spawnSync({
    cmd: ["bun", "run", "drizzle-kit", "push", "--force"],
    env: { ...process.env, DATABASE_URL: url },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`drizzle-kit push exited with code ${proc.exitCode}`);
  }
}
