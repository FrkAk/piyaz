/**
 * Apply the owner-managed RLS SQL: the piyaz_auth grants
 * (docker/grants-auth.sql) and the SECURITY DEFINER helpers + triggers
 * (docker/rls-functions.sql). These read or own piyaz_auth, so they must run as
 * the database owner — never the least-privilege migration role. Idempotent
 * (CREATE OR REPLACE / GRANT).
 *
 * Reads DATABASE_OWNER_URL — set this only in a trusted local shell, never as a
 * CI secret.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const OWNER_RLS_FILES = ["grants-auth.sql", "rls-functions.sql"] as const;

/**
 * Read the owner connection string from the environment.
 *
 * @returns The database-owner DIRECT connection string.
 * @throws Error when DATABASE_OWNER_URL is unset.
 */
function ownerUrl(): string {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    throw new Error(
      "DATABASE_OWNER_URL is required to apply owner-managed RLS (database owner role).",
    );
  }
  return url;
}

/**
 * Read a SQL file from the docker/ directory.
 *
 * @param file - File name under docker/.
 * @returns The file contents.
 */
function readDockerSql(file: string): string {
  return readFileSync(join(process.cwd(), "docker", file), "utf8");
}

/**
 * Apply the owner-managed grants and functions.
 *
 * @param url - Database-owner connection string.
 * @throws Error when a file fails to apply.
 */
async function applyOwnerRls(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    for (const file of OWNER_RLS_FILES) {
      await sql.unsafe(readDockerSql(file));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  await applyOwnerRls(ownerUrl());
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
