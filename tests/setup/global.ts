import { startContainer, stopContainer } from "./container";
import { applyMigrations } from "./migrate";

declare global {
  var __mymirTestSetupRan: boolean | undefined;
}

/**
 * Idempotent global setup: start the test container and apply migrations
 * once per process. Subsequent calls are no-ops. Call from `beforeAll`
 * in test files that need real DB access.
 */
export async function setup() {
  if (globalThis.__mymirTestSetupRan) return;
  const url = await startContainer();
  process.env.DATABASE_URL = url;
  await applyMigrations(url);
  globalThis.__mymirTestSetupRan = true;
}

/** Stop the test container. Call from `afterAll` if you want explicit
 * teardown, but Bun will reap the container on process exit anyway. */
export async function teardown() {
  await stopContainer();
  globalThis.__mymirTestSetupRan = false;
}
