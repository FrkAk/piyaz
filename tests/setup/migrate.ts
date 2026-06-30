import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

/**
 * Provision the test container with the same role split the self-host
 * Docker compose file builds: `app_user` (no BYPASSRLS, runtime role
 * exercising RLS) and `service_role` (BYPASSRLS, runs migrations and the
 * documented bypass call sites).
 *
 * The testcontainer can't run `docker/init-rls.sh` from
 * `/docker-entrypoint-initdb.d/` (it ships POSTGRES_USER=piyaz without
 * the password env vars), so we replicate the role + grant steps here.
 *
 * @param sql - Active postgres client (must be the container superuser).
 */
async function provisionRoles(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        EXECUTE 'CREATE ROLE app_user LOGIN NOBYPASSRLS PASSWORD ''app_user''';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'CREATE ROLE service_role LOGIN BYPASSRLS PASSWORD ''service_role''';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_role') THEN
        EXECUTE 'CREATE ROLE auth_role LOGIN NOBYPASSRLS PASSWORD ''auth_role''';
      END IF;
    END $$;
  `);

  const [{ current_database: db }] = await sql<{ current_database: string }[]>`
    SELECT current_database()
  `;
  await sql.unsafe(`REVOKE TEMPORARY ON DATABASE "${db}" FROM PUBLIC`);
}

/**
 * Apply `docker/grants.sql` (public) and `docker/grants-auth.sql` (piyaz_auth)
 * after `drizzle-kit push` so the `GRANT … ON ALL TABLES` statements land on
 * the just-created tables. Running grants before push is a no-op for those
 * statements — push then creates tables that app_user/service_role have zero
 * grants on, and the first test process after a fresh container fails with
 * `permission denied for table tasks`.
 *
 * @param sql - Active postgres client (must be the container superuser).
 */
async function applyGrants(sql: ReturnType<typeof postgres>): Promise<void> {
  for (const file of ["grants.sql", "grants-auth.sql"]) {
    const grants = readFileSync(join(process.cwd(), "docker", file), "utf8");
    await sql.unsafe(grants);
  }
}

/**
 * Apply `docker/storage.sql` (physical lz4 column compression) after
 * `drizzle-kit push`. The `SET COMPRESSION` DDL Drizzle's schema model cannot
 * express lives outside the generated schema, so the push-based test DB applies
 * it here to mirror the migrate-based deploy path. Idempotent.
 *
 * @param sql - Active postgres client (must be the container superuser).
 */
async function applyStorage(sql: ReturnType<typeof postgres>): Promise<void> {
  const content = readFileSync(
    join(process.cwd(), "docker", "storage.sql"),
    "utf8",
  );
  await sql.unsafe(content);
}

/**
 * Apply the hand-written RLS policy DDL from `docker/rls-policies.sql`.
 * Run after `drizzle-kit push` because each policy references public
 * tables that push creates first. The file is idempotent
 * (`DROP POLICY IF EXISTS` + `CREATE POLICY`), so re-runs are safe.
 *
 * Split on semicolons rather than the drizzle `--> statement-breakpoint`
 * marker because this file is plain SQL, not a drizzle-generated migration.
 *
 * @param sql - Active postgres client (uses superuser or service_role).
 */
async function applyRlsPolicies(
  sql: ReturnType<typeof postgres>,
): Promise<void> {
  const content = readFileSync(
    join(process.cwd(), "docker", "rls-policies.sql"),
    "utf8",
  );
  // Strip line comments first, then split on `;`. Splitting first leaves
  // leading `-- comment` lines glued to the next statement, which trips
  // the `startsWith('--')` filter and silently drops the whole chunk.
  const stripped = content
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements = stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }
}

/**
 * Apply the SECURITY DEFINER helper functions from `docker/rls-functions.sql`.
 * Run after `applyRlsPolicies` so the functions exist alongside the policies
 * they complement. Idempotent (`CREATE OR REPLACE FUNCTION`).
 *
 * @param sql - Active postgres client (uses superuser).
 */
async function applyRlsFunctions(
  sql: ReturnType<typeof postgres>,
): Promise<void> {
  const content = readFileSync(
    join(process.cwd(), "docker", "rls-functions.sql"),
    "utf8",
  );
  // The function bodies contain `$$ ... $$` dollar-quoted blocks; naïve
  // semicolon-splitting would break them. Apply as a single batch since
  // CREATE OR REPLACE FUNCTION is idempotent.
  await sql.unsafe(content);
}

/**
 * Apply `docker/init-auth.sql` (the piyaz_auth schema for self-hosted
 * Postgres), provision the RLS role split (`app_user` + `service_role`),
 * run `drizzle-kit push` to create the public schema, then apply
 * `docker/rls-policies.sql` so RLS policies land. Run once per container
 * at `globalSetup`.
 *
 * `drizzle-kit push` is used (not `migrate`) because the project doesn't
 * maintain a migration journal pre-v0.1. Policies live entirely in
 * hand-written SQL because push's introspection-based diff silently drops
 * the `USING`/`WITH CHECK` clauses on `pgPolicy()` declarations.
 *
 * @param url - Connection string for the target database.
 */
export async function applyMigrations(url: string): Promise<void> {
  const sql = postgres(url, {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    const initAuth = readFileSync(
      join(process.cwd(), "docker", "init-auth.sql"),
      "utf8",
    );
    await sql.unsafe(initAuth);
    // `init-auth.sql` calls `SET search_path TO piyaz_auth` for the duration
    // of its CREATE TABLEs. The setting persists on the pooled connection;
    // reset it so subsequent statements land in the `public` schema.
    await sql.unsafe("SET search_path TO public, piyaz_auth");
    await provisionRoles(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }

  const proc = Bun.spawnSync({
    cmd: ["bun", "run", "drizzle-kit", "push", "--force"],
    env: { ...process.env, DATABASE_URL: url, DATABASE_SERVICE_ROLE_URL: url },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`drizzle-kit push exited with code ${proc.exitCode}`);
  }

  // `DROP POLICY IF EXISTS` in docker/rls-policies.sql emits routine
  // NOTICE chatter on a fresh DB; muted on the JS side via `onnotice`.
  const sqlPolicies = postgres(url, {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await applyGrants(sqlPolicies);
    await applyRlsFunctions(sqlPolicies);
    await applyRlsPolicies(sqlPolicies);
    await applyStorage(sqlPolicies);
  } finally {
    await sqlPolicies.end({ timeout: 5 });
  }
}
