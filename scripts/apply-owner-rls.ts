/**
 * Apply the owner-managed database SQL: extensions, the piyaz_auth schema,
 * grants, request-path role settings, and SECURITY DEFINER helpers/triggers.
 * These create extensions, alter or read piyaz_auth, or need ADMIN OPTION on
 * a role, so they must run as the database owner, never the least-privilege
 * migration role. Every file is idempotent.
 *
 * Reads DATABASE_OWNER_URL and BETTER_AUTH_URL. Set the owner URL only in a
 * trusted local shell, never as a CI secret. Nothing here lands on a deploy:
 * run it once per environment, and against hosted dev before hosted prod.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { getOAuthResourceIdentifiers } from "@/lib/auth/oauth-resource";

const OWNER_MANAGED_FILES = [
  "extensions.sql",
  "init-auth.sql",
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
 * Resolve the environment-specific OAuth resources before database writes.
 *
 * @throws Error when BETTER_AUTH_URL is unset.
 * @returns The configured origin and canonical MCP resource identifiers.
 */
function resolveOAuthResources(): string[] {
  if (!process.env.BETTER_AUTH_URL) {
    throw new Error(
      "BETTER_AUTH_URL is required so db:rls:owner can seed OAuth resources before Better Auth 1.7 boots.",
    );
  }
  return getOAuthResourceIdentifiers();
}

/**
 * Seed the environment-specific OAuth resources before the 1.7 runtime boots.
 *
 * @param sql - Active database-owner client.
 * @param identifiers - Validated OAuth resource identifiers.
 * @returns A promise that resolves after all resources are present.
 */
async function seedOAuthResources(
  sql: ReturnType<typeof postgres>,
  identifiers: readonly string[],
): Promise<void> {
  for (const identifier of identifiers) {
    await sql`
      INSERT INTO piyaz_auth."oauthResource" ("identifier", "name")
      VALUES (${identifier}, ${identifier})
      ON CONFLICT ("identifier") DO NOTHING
    `;
  }
}

/**
 * Apply the owner-managed grants and functions.
 *
 * @param url - Database-owner connection string.
 * @throws Error when a file fails to apply.
 */
async function applyOwnerRls(url: string): Promise<void> {
  const oauthResources = resolveOAuthResources();
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    for (const file of OWNER_MANAGED_FILES) {
      await sql.unsafe(readDockerSql(file));
    }
    await seedOAuthResources(sql, oauthResources);
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
