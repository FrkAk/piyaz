import postgres from "postgres";
import { applyMigrations } from "./migrate";

declare global {
  var __mymirTestSetupRan: boolean | undefined;
  var __mymirTestUrl: string | undefined;
}

/**
 * Default superuser URL when `TEST_DATABASE_URL` is unset — matches the
 * host port exposed by `docker-compose.test.yml`. CI sets the env var
 * explicitly to point at the Actions `services: postgres:` sidecar.
 */
const DEFAULT_LOCAL_URL = "postgres://mymir:mymir@localhost:5433/mymir_test";

/**
 * Read the superuser connection string used by helpers that need to seed
 * fixtures or truncate tables outside RLS. Available after `setup()` has
 * resolved.
 *
 * @returns The superuser connection string.
 * @throws Error when `setup()` has not yet completed.
 */
export function getConnectionString(): string {
  if (!globalThis.__mymirTestUrl) {
    throw new Error(
      "Test database not initialized. Did `setup()` run? " +
        "Run `bun run db:test:up` locally, or set TEST_DATABASE_URL.",
    );
  }
  return globalThis.__mymirTestUrl;
}

/**
 * Poll `SELECT 1` against the superuser URL until the server accepts a
 * connection. The docker-compose / Actions healthcheck should make this
 * usually a single-iteration check, but the loop survives a slow first
 * boot or a runner that proceeds before the healthcheck flips green.
 *
 * @param url - Superuser connection string.
 * @throws Error after 30s of failed attempts.
 */
async function waitForPostgres(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const sql = postgres(url, { max: 1, connect_timeout: 2 });
    try {
      await sql`SELECT 1`;
      await sql.end({ timeout: 1 });
      return;
    } catch (err) {
      lastError = err;
      await sql.end({ timeout: 1 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const redacted = url.replace(/:[^@]+@/, ":***@");
  throw new Error(
    `Test Postgres at ${redacted} not reachable within 30s. ` +
      `Run \`bun run db:test:up\` locally, or check the CI service. ` +
      `Last error: ${String(lastError)}`,
  );
}

/**
 * Idempotent global setup: wait for the externally-provisioned test
 * Postgres (docker compose locally, GitHub Actions service in CI),
 * apply migrations + roles + RLS as the superuser, then rewrite
 * `DATABASE_URL`, `DATABASE_AUTH_URL`, and `DATABASE_SERVICE_ROLE_URL`
 * to their RLS-bound roles so every test exercises production semantics.
 * Subsequent calls are no-ops.
 */
export async function setup(): Promise<void> {
  if (globalThis.__mymirTestSetupRan) return;
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_LOCAL_URL;
  await waitForPostgres(url);
  globalThis.__mymirTestUrl = url;
  const rewriteRole = (role: string) =>
    url.replace(
      /^(postgres(?:ql)?):\/\/[^:]+:[^@]+@/,
      `$1://${role}:${role}@`,
    );
  await applyMigrations(url);
  process.env.DATABASE_URL = rewriteRole("app_user");
  process.env.DATABASE_AUTH_URL = rewriteRole("auth_role");
  process.env.DATABASE_SERVICE_ROLE_URL = rewriteRole("service_role");
  globalThis.__mymirTestSetupRan = true;
}
