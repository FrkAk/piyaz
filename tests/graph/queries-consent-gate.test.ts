import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setBackend } from "@/lib/api/rate-limit";
import { MemoryRateLimitBackend } from "@/lib/api/rate-limit-memory";
import { RECONSENT_PATH } from "@/lib/auth/consent";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { nextHeadersMockModule } from "@/tests/setup/next-headers-mock";

/**
 * Placement guard for the palette query actions in `lib/graph/queries.ts`.
 * Those actions resolve the session and rate-limit outside a try/catch,
 * then read tenant data inside one. The consent gate must run BEFORE that
 * try: placed inside it, `redirect()`'s `NEXT_REDIRECT` control error would
 * be swallowed into a generic `unknown` failure and the stale caller would
 * see an error instead of the interstitial. `listMyTasks` stands in for the
 * three structurally identical actions.
 */

mock.module("next/headers", nextHeadersMockModule);

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

beforeEach(() => {
  setBackend("actions", new MemoryRateLimitBackend(60_000));
});

afterEach(async () => {
  setSession(null);
  await truncateAll();
});

describe("palette query actions consent gate", () => {
  test("listMyTasks redirects a stale caller instead of swallowing it", async () => {
    const user = await seedUserOrgProject("queries-gate-stale", {
      legalCurrent: false,
    });
    setSession({ user: { id: user.userId } });
    const { listMyTasks } = await import("@/lib/graph/queries");

    let thrown: unknown;
    try {
      await listMyTasks();
    } catch (err) {
      thrown = err;
    }
    const digest = (thrown as { digest?: string } | undefined)?.digest ?? "";
    expect(digest).toStartWith("NEXT_REDIRECT");
    expect(digest).toContain(RECONSENT_PATH);
  });

  test("listMyTasks returns rows for a current caller", async () => {
    const user = await seedUserOrgProject("queries-gate-current");
    setSession({ user: { id: user.userId } });
    const { listMyTasks } = await import("@/lib/graph/queries");

    const result = await listMyTasks();
    expect(result.ok).toBe(true);
  });
});
