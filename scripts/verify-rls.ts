/**
 * Verify the live database satisfies the public RLS contract and that the
 * owner-managed SECURITY DEFINER functions are present. Read-only: runs as the
 * migration role (system catalogs are world-readable). Exits non-zero with an
 * actionable message so a forgotten owner apply or policy drift blocks the
 * deploy instead of shipping broken RLS.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

/** Names the repo expects the target database to expose. */
interface ExpectedContract {
  policies: Array<{ table: string; policy: string }>;
  forcedTables: string[];
  functions: string[];
}

/**
 * Read the migration connection string from the environment.
 *
 * @returns The migrator DIRECT connection string.
 * @throws Error when DATABASE_MIGRATION_URL is unset.
 */
function migrationUrl(): string {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    throw new Error("DATABASE_MIGRATION_URL is required to verify RLS.");
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
 * Extract the expected policies, FORCE-RLS tables, and SECURITY DEFINER
 * function names from the hand-written docker SQL (the single source of truth).
 *
 * @returns The contract the live database must satisfy.
 */
function expectedContract(): ExpectedContract {
  const policiesSql = readDockerSql("rls-policies.sql");
  const functionsSql = readDockerSql("rls-functions.sql");

  const policies = [
    ...policiesSql.matchAll(/CREATE\s+POLICY\s+"([^"]+)"\s+ON\s+"([^"]+)"/gi),
  ].map((m) => ({ policy: m[1], table: m[2] }));

  const forcedTables = [
    ...policiesSql.matchAll(
      /ALTER\s+TABLE\s+"([^"]+)"\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi,
    ),
  ].map((m) => m[1]);

  const functions = [
    ...functionsSql.matchAll(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(\w+)\s*\(/gi,
    ),
  ].map((m) => m[1]);

  return {
    policies,
    forcedTables: [...new Set(forcedTables)],
    functions: [...new Set(functions)],
  };
}

/**
 * Compare the repo contract against the live catalogs.
 *
 * @param sql - Active read-only postgres client.
 * @param expected - Contract extracted from the docker SQL.
 * @returns One description per missing item (empty when satisfied).
 */
async function findMissing(
  sql: ReturnType<typeof postgres>,
  expected: ExpectedContract,
): Promise<string[]> {
  const policyKey = (table: string, policy: string): string =>
    `${table}.${policy}`;

  const livePolicies = await sql<{ tablename: string; policyname: string }[]>`
    SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'
  `;
  const livePolicySet = new Set(
    livePolicies.map((r) => policyKey(r.tablename, r.policyname)),
  );

  const liveForced = await sql<{ relname: string }[]>`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
  `;
  const liveForcedSet = new Set(liveForced.map((r) => r.relname));

  const liveFunctions = await sql<{ proname: string }[]>`
    SELECT p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  `;
  const liveFunctionSet = new Set(liveFunctions.map((r) => r.proname));

  const missing: string[] = [];
  for (const { table, policy } of expected.policies) {
    if (!livePolicySet.has(policyKey(table, policy))) {
      missing.push(`policy "${policy}" on ${table}`);
    }
  }
  for (const table of expected.forcedTables) {
    if (!liveForcedSet.has(table)) {
      missing.push(`FORCE ROW LEVEL SECURITY on ${table}`);
    }
  }
  for (const fn of expected.functions) {
    if (!liveFunctionSet.has(fn)) {
      missing.push(`function public.${fn}`);
    }
  }
  return missing;
}

/**
 * Run the verification and throw with an actionable message on any miss.
 *
 * @param url - Migrator connection string.
 * @throws Error when the live database is missing an expected item.
 */
async function verifyRls(url: string): Promise<void> {
  const expected = expectedContract();
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  let missing: string[];
  try {
    missing = await findMissing(sql, expected);
  } finally {
    await sql.end({ timeout: 5 });
  }
  if (missing.length > 0) {
    const list = missing.map((m) => `  - ${m}`).join("\n");
    throw new Error(
      `RLS contract not satisfied on the target database:\n${list}\n` +
        "Apply the owner-managed SQL as the database owner (db:rls:owner) " +
        "and re-run the deploy.",
    );
  }
}

try {
  await verifyRls(migrationUrl());
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
