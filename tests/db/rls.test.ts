import { afterEach, describe, expect, test } from "bun:test";
import { withUserContext } from "@/lib/db/rls";
import { truncateAll } from "@/tests/setup/schema";
import { appUserConnect, seedUserOrgProject } from "@/tests/setup/seed";

describe("withUserContext userId validation", () => {
  test("rejects empty userId", async () => {
    await expect(withUserContext("", async () => 1)).rejects.toThrow(
      /valid UUID/i,
    );
  });

  test("rejects ASCII whitespace-only userId", async () => {
    await expect(withUserContext("   ", async () => 1)).rejects.toThrow(
      /valid UUID/i,
    );
  });

  test("rejects Unicode whitespace (U+00A0 non-breaking space)", async () => {
    await expect(withUserContext(" ", async () => 1)).rejects.toThrow(
      /valid UUID/i,
    );
  });

  test("rejects Unicode whitespace (U+2003 em space)", async () => {
    await expect(withUserContext(" ", async () => 1)).rejects.toThrow(
      /valid UUID/i,
    );
  });

  test("rejects non-UUID payload (e.g., session token)", async () => {
    await expect(
      withUserContext("not-a-uuid", async () => 1),
    ).rejects.toThrow(/valid UUID/i);
  });

  test("rejects null/undefined userId types", async () => {
    await expect(
      // @ts-expect-error testing runtime guard
      withUserContext(null, async () => 1),
    ).rejects.toThrow(/valid UUID/i);
    await expect(
      // @ts-expect-error testing runtime guard
      withUserContext(undefined, async () => 1),
    ).rejects.toThrow(/valid UUID/i);
  });

  test("accepts a valid UUID and runs the callback", async () => {
    const sentinel = Symbol("ok");
    const result = await withUserContext(
      "00000000-0000-0000-0000-000000000000",
      async () => sentinel,
    );
    expect(result).toBe(sentinel);
  });
});

describe("withUserContext GUC isolation", () => {
  afterEach(async () => {
    await truncateAll();
  });

  test("concurrent frames see only their own org's rows", async () => {
    const teamA = await seedUserOrgProject("guc-iso-a");
    const teamB = await seedUserOrgProject("guc-iso-b");

    // Two parallel frames, each fetching the project list under its own
    // user. If `app.user_id` leaked between connections, either side
    // could see the other's row.
    const [seenByA, seenByB] = await Promise.all([
      withUserContext(teamA.userId, async (tx) =>
        tx.execute<{ id: string }>(
          `SELECT id FROM public.projects` as unknown as never,
        ),
      ),
      withUserContext(teamB.userId, async (tx) =>
        tx.execute<{ id: string }>(
          `SELECT id FROM public.projects` as unknown as never,
        ),
      ),
    ]);

    const idsA = (seenByA as unknown as { id: string }[]).map((r) => r.id);
    const idsB = (seenByB as unknown as { id: string }[]).map((r) => r.id);

    expect(idsA).toEqual([teamA.projectId]);
    expect(idsB).toEqual([teamB.projectId]);
  });

  test("GUC is empty on a fresh connection after a transaction aborts", async () => {
    const fx = await seedUserOrgProject("guc-abort");
    const sentinel = "throw-to-reset";

    // Throw inside the callback so the transaction rolls back. Postgres
    // discards `set_config(..., is_local=true)` on commit AND rollback;
    // this pins that contract instead of trusting the driver.
    await expect(
      withUserContext(fx.userId, async () => {
        throw new Error(sentinel);
      }),
    ).rejects.toThrow(sentinel);

    // Different connection (bare pool). The GUC must report empty.
    const c = appUserConnect();
    const [row] =
      await c<{ value: string }[]>`SELECT current_setting('app.user_id', TRUE) AS value`;
    expect(row.value === "" || row.value === null).toBe(true);
  });
});
