import { mock } from "bun:test";

// Neutralize `server-only` so lib/ modules can be imported in the test process.
mock.module("server-only", () => ({}));

// Stub Better Auth initialization to prevent URL-parse errors in test process.
// `makeAuthContext` doesn't call `requireSession`; stub is sufficient.
mock.module("@/lib/auth/session", () => ({
  getSession: async () => null,
  requireSession: async () => {
    throw new Error("requireSession is not available in tests");
  },
}));

import { setup, teardown } from "./global";
import { beforeAll, afterAll } from "bun:test";

beforeAll(async () => {
  await setup();
}, 120000);

afterAll(async () => {
  await teardown();
}, 30000);
