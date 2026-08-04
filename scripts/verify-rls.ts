/**
 * Verify the live database satisfies the public RLS contract: policies,
 * FORCE RLS, the owner-managed extensions, functions AND triggers, lz4
 * compression, and the append-only REVOKE narrowing. Read-only: runs as the migration role
 * (system catalogs are world-readable). Exits non-zero with an actionable
 * message so a forgotten owner apply, grant drift, or policy drift blocks the
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
  triggers: Array<{ table: string; trigger: string }>;
  extensions: Array<{ name: string; schema: string | null }>;
}

/**
 * Privileges grants.sql revokes after its schema-wide GRANT. The REVOKE lives
 * in a table-existence-guarded DO block that self-skips at container-init, so
 * grant drift (e.g. a manual schema-wide re-GRANT) must be caught here.
 */
const REVOKED_PRIVILEGES = [
  { role: "app_user", table: "public.note_revisions", privilege: "UPDATE" },
  { role: "app_user", table: "public.note_folders", privilege: "UPDATE" },
] as const;

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
 * Extract the expected policies, FORCE-RLS tables, SECURITY DEFINER
 * function names, and extensions from the hand-written docker SQL (the
 * single source of truth).
 *
 * @returns The contract the live database must satisfy.
 */
function expectedContract(): ExpectedContract {
  const policiesSql = readDockerSql("rls-policies.sql");
  const functionsSql = readDockerSql("rls-functions.sql");
  const extensionsSql = readDockerSql("extensions.sql");

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

  // Matches trigger DDL both bare and inside the table-existence-guarded
  // EXECUTE '...' blocks (the notes-family triggers self-skip when
  // db:rls:owner runs before the migration; this assertion is what makes
  // that skip loud on the deploy DB).
  const triggers = [
    ...functionsSql.matchAll(
      /CREATE\s+TRIGGER\s+(\w+)[\s\S]*?\bON\s+public\.(\w+)/gi,
    ),
  ].map((m) => ({ trigger: m[1], table: m[2] }));

  // Both halves are load-bearing: CREATE EXTENSION IF NOT EXISTS does NOT
  // relocate an extension that already exists in another schema (it no-ops
  // with a notice), and scripts/db-stats.ts addresses the views through the
  // declared schema. A name-only check would pass on a database carrying a
  // pre-existing public-schema install while the read path 42P01s.
  const extensions = [
    ...extensionsSql.matchAll(
      /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+(\w+)(?:\s+WITH\s+SCHEMA\s+(\w+))?/gi,
    ),
  ].map((m) => ({ name: m[1], schema: m[2] ?? null }));

  return {
    policies,
    forcedTables: [...new Set(forcedTables)],
    functions: [...new Set(functions)],
    triggers,
    extensions,
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

  const liveTriggers = await sql<{ tgname: string; relname: string }[]>`
    SELECT t.tgname, c.relname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  `;
  const liveTriggerSet = new Set(
    liveTriggers.map((r) => `${r.relname}.${r.tgname}`),
  );

  const liveExtensions = await sql<{ extname: string; nspname: string }[]>`
    SELECT e.extname, n.nspname
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
  `;
  const liveExtensionSet = new Set(
    liveExtensions.map((r) => `${r.extname}.${r.nspname}`),
  );
  const liveExtensionNames = new Set(liveExtensions.map((r) => r.extname));

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
  for (const { table, trigger } of expected.triggers) {
    if (!liveTriggerSet.has(`${table}.${trigger}`)) {
      missing.push(`trigger "${trigger}" on ${table}`);
    }
  }
  for (const { name, schema } of expected.extensions) {
    const present = schema
      ? liveExtensionSet.has(`${name}.${schema}`)
      : liveExtensionNames.has(name);
    if (!present) {
      missing.push(
        schema ? `extension ${name} in schema ${schema}` : `extension ${name}`,
      );
    }
  }

  for (const { role, table, privilege } of REVOKED_PRIVILEGES) {
    const [row] = await sql<{ granted: boolean | null }[]>`
      SELECT CASE
        WHEN to_regclass(${table}) IS NULL THEN NULL
        ELSE has_table_privilege(${role}, ${table}, ${privilege})
      END AS granted
    `;
    if (row?.granted !== false) {
      missing.push(`REVOKE ${privilege} ON ${table} FROM ${role}`);
    }
  }

  // lz4 TOAST compression lives in docker/storage.sql (drizzle has no
  // compression API), applied by apply-public-rls.ts after migrate. Assert it
  // here against the deploy DB so a missing or failed storage apply fails the
  // deploy instead of silently shipping pglz.
  const lz4Columns = [
    { table: "notes", column: "body" },
    { table: "notes", column: "search_tsv" },
    { table: "note_revisions", column: "body" },
  ];
  for (const { table, column } of lz4Columns) {
    const [col] = await sql<{ attcompression: string }[]>`
      SELECT attcompression
      FROM pg_attribute
      WHERE attrelid = to_regclass(${`public.${table}`})
        AND attname = ${column}
        AND NOT attisdropped
    `;
    if (col?.attcompression !== "l") {
      missing.push(`lz4 compression on ${table}.${column}`);
    }
  }

  // statement_timeout lives in docker/role-settings.sql as a role default,
  // applied by db:rls (self-host) or db:rls:owner (hosted) and never by a
  // deploy. Without this assertion a forgotten owner apply leaves the request
  // path with no statement ceiling at all, silently and permanently, while the
  // code comments claim the bound exists. The exact value is asserted: a
  // presence match would accept `statement_timeout=0`, the no-ceiling state
  // this check exists to catch.
  for (const role of ["app_user", "auth_role"]) {
    const [setting] = await sql<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_db_role_setting s
        JOIN pg_roles r ON r.oid = s.setrole
        WHERE r.rolname = ${role}
          AND s.setdatabase = 0
          AND 'statement_timeout=15s' = ANY (s.setconfig)
      ) AS present
    `;
    if (!setting?.present) {
      missing.push(`statement_timeout=15s role default on ${role}`);
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
        "for missing extensions/functions/triggers, re-run the public apply " +
        "(db:rls:ci) for grants/policies/compression, then re-run the deploy. " +
        "An extension already installed in a different schema needs an " +
        "owner-run ALTER EXTENSION ... SET SCHEMA instead: CREATE EXTENSION " +
        "IF NOT EXISTS cannot relocate it.",
    );
  }
}

try {
  await verifyRls(migrationUrl());
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
