/**
 * Apply the owner-managed RLS SQL: the extensions (docker/extensions.sql),
 * the piyaz_auth grants (docker/grants-auth.sql), the request-path role
 * settings (docker/role-settings.sql) and the SECURITY DEFINER helpers +
 * triggers (docker/rls-functions.sql). These create extensions, read or own
 * piyaz_auth, or need ADMIN OPTION on a role, so they must run as the
 * database owner, never the least-privilege migration role. Idempotent
 * (CREATE EXTENSION IF NOT EXISTS / CREATE OR REPLACE / GRANT /
 * ALTER ROLE ... SET).
 *
 * Reads DATABASE_OWNER_URL. Set this only in a trusted local shell, never as a
 * CI secret. Nothing here lands on a deploy: run it once per environment, and
 * against hosted dev before hosted prod.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const OWNER_RLS_FILES = [
  "extensions.sql",
  "grants-auth.sql",
  "role-settings.sql",
  "rls-functions.sql",
] as const;

/**
 * Read the owner connection string from the environment. Shared by every
 * owner-run script (`db:rls:owner`, `db:stats`) so the env-var name and the
 * trusted-shell contract live in one place.
 *
 * @returns The database-owner DIRECT connection string.
 * @throws Error when DATABASE_OWNER_URL is unset.
 */
export function ownerUrl(): string {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    throw new Error(
      "DATABASE_OWNER_URL is required (database owner role; set it only in a trusted local shell).",
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

if (import.meta.main) {
  try {
    await applyOwnerRls(ownerUrl());
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
