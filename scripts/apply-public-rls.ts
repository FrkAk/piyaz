/**
 * Re-apply the public-schema RLS contract (grants + policies) after
 * `drizzle-kit migrate`. Runs as the migration role, which owns `public` and is
 * therefore authorized to GRANT, CREATE POLICY, and FORCE ROW LEVEL SECURITY
 * there with no escalation. The piyaz_auth grants and SECURITY DEFINER helpers
 * are owner-only and applied separately (scripts/apply-owner-rls.ts).
 *
 * Both files apply inside one transaction so the DROP POLICY/CREATE POLICY
 * re-apply in rls-policies.sql has no deny-all window.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const PUBLIC_RLS_FILES = ["grants.sql", "rls-policies.sql"] as const;

/**
 * Read the migration connection string from the environment.
 *
 * @returns The migrator DIRECT connection string.
 * @throws Error when DATABASE_MIGRATION_URL is unset.
 */
function migrationUrl(): string {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    throw new Error(
      "DATABASE_MIGRATION_URL is required to apply public RLS (migration role).",
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
 * Apply the public-schema grants and policies in a single transaction.
 *
 * @param url - Migrator connection string.
 * @throws Error when the transaction fails.
 */
async function applyPublicRls(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await sql.begin(async (tx) => {
      for (const file of PUBLIC_RLS_FILES) {
        await tx.unsafe(readDockerSql(file));
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  await applyPublicRls(migrationUrl());
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
