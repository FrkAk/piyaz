import { afterEach, describe, expect, mock, test } from "bun:test";
import { withUserContext } from "@/lib/db/rls";
import { legalAcceptances } from "@/lib/db/schema";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import { acceptUpdatedLegalAction } from "@/lib/actions/legal";
import { recordAcceptance } from "@/lib/data/legal";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { nextHeadersMockModule } from "@/tests/setup/next-headers-mock";

/**
 * Contract for `acceptUpdatedLegalAction`: the server derives the
 * outstanding personal documents itself (no client input), writes one
 * pinned-version row per outstanding document with the request's IP and
 * user-agent, and is idempotent when nothing is outstanding.
 * `requireSession` is driven via the preload's `__setTestSession`
 * container, and `next/headers` is mocked at file top so the action's
 * internal `headers()` resolves outside a request.
 */

mock.module("next/headers", nextHeadersMockModule);

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

afterEach(async () => {
  setSession(null);
  await truncateAll();
});

describe("acceptUpdatedLegalAction", () => {
  test("rejects an unauthenticated caller", async () => {
    const result = await acceptUpdatedLegalAction();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable: ok asserted above");
    expect(result.code).toBe("unauthorized");
  });

  test("writes exactly the missing document's row for a partially current user", async () => {
    const user = await seedUserOrgProject("reconsent-partial", {
      legalCurrent: false,
    });
    await recordAcceptance(user.userId, "terms", {
      ipAddress: null,
      userAgent: null,
    });
    setSession({ user: { id: user.userId } });

    const result = await acceptUpdatedLegalAction();

    expect(result.ok).toBe(true);
    const rows = await withUserContext(user.userId, async (tx) =>
      tx.select().from(legalAcceptances),
    );
    expect(rows.length).toBe(2);
    const privacy = rows.find((row) => row.documentType === "privacy");
    expect(privacy).toBeDefined();
    expect(privacy!.documentVersion).toBe(LEGAL_VERSIONS.privacy);
    expect(privacy!.userId).toBe(user.userId);
  });

  test("writes both documents for a fully stale user", async () => {
    const user = await seedUserOrgProject("reconsent-stale", {
      legalCurrent: false,
    });
    await withUserContext(user.userId, async (tx) => {
      await tx.insert(legalAcceptances).values([
        {
          userId: user.userId,
          documentType: "terms",
          documentVersion: "beta-superseded",
        },
        {
          userId: user.userId,
          documentType: "privacy",
          documentVersion: "beta-superseded",
        },
      ]);
    });
    setSession({ user: { id: user.userId } });

    const result = await acceptUpdatedLegalAction();

    expect(result.ok).toBe(true);
    const rows = await withUserContext(user.userId, async (tx) =>
      tx.select().from(legalAcceptances),
    );
    const current = rows.filter(
      (row) => row.documentVersion === LEGAL_VERSIONS[row.documentType],
    );
    expect(current.map((row) => row.documentType).sort()).toEqual([
      "privacy",
      "terms",
    ]);
  });

  test("succeeds without writing when nothing is outstanding", async () => {
    const user = await seedUserOrgProject("reconsent-current", {
      legalCurrent: false,
    });
    await recordAcceptance(user.userId, "terms", {
      ipAddress: null,
      userAgent: null,
    });
    await recordAcceptance(user.userId, "privacy", {
      ipAddress: null,
      userAgent: null,
    });
    setSession({ user: { id: user.userId } });

    const result = await acceptUpdatedLegalAction();

    expect(result.ok).toBe(true);
    const rows = await withUserContext(user.userId, async (tx) =>
      tx.select().from(legalAcceptances),
    );
    expect(rows.length).toBe(2);
  });
});
