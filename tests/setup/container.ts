import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Wait } from "testcontainers";

declare global {
  var __mymirTestContainer: StartedPostgreSqlContainer | undefined;
  var __mymirTestUrl: string | undefined;
}

/**
 * Start a single Postgres 17 container for the test run. Idempotent —
 * subsequent calls return the same connection string. Cached on
 * `globalThis` so multiple test files share one container.
 *
 * @returns The connection string (libpq URI form).
 */
export async function startContainer(): Promise<string> {
  if (globalThis.__mymirTestUrl) return globalThis.__mymirTestUrl;
  // Use log-message wait strategy: the default health-check + port-check
  // strategy uses `docker exec` streams which hang in Bun's runtime.
  const container = await new PostgreSqlContainer("postgres:17.6")
    .withDatabase("mymir_test")
    .withUsername("mymir")
    .withPassword("mymir")
    .withWaitStrategy(
      Wait.forLogMessage(
        "database system is ready to accept connections",
        2,
      ).withStartupTimeout(60000),
    )
    .start();
  const url = container.getConnectionUri();
  globalThis.__mymirTestContainer = container;
  globalThis.__mymirTestUrl = url;
  return url;
}

/** Stop the container if one is running. Safe to call multiple times. */
export async function stopContainer(): Promise<void> {
  const container = globalThis.__mymirTestContainer;
  if (!container) return;
  await container.stop();
  globalThis.__mymirTestContainer = undefined;
  globalThis.__mymirTestUrl = undefined;
}

/**
 * Read the connection string the active container is serving.
 *
 * @returns Connection string.
 * @throws Error if the container hasn't been started yet.
 */
export function getConnectionString(): string {
  if (!globalThis.__mymirTestUrl) {
    throw new Error(
      "Test Postgres container is not running. Did `setup()` run?",
    );
  }
  return globalThis.__mymirTestUrl;
}
