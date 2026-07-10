import { afterEach, describe, expect, test } from "bun:test";
import { LEGAL_USER_AGENT_MAX_CHARS, legalAcceptances } from "@/lib/db/schema";
import { withUserContext } from "@/lib/db/rls";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import { recordAcceptance } from "@/lib/data/legal";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { captureAppUserError } from "@/tests/setup/expect-query";

describe("legal_acceptances RLS isolation", () => {
  afterEach(async () => {
    await truncateAll();
  });

  test("recordAcceptance persists a row the same user can read back", async () => {
    const userA = await seedUserOrgProject("legal-a");

    await recordAcceptance(userA.userId, "terms", {
      ipAddress: "203.0.113.7",
      userAgent: "test-agent",
    });

    const rows = await withUserContext(userA.userId, async (tx) =>
      tx.select().from(legalAcceptances),
    );

    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe(userA.userId);
    expect(rows[0].documentType).toBe("terms");
    expect(rows[0].documentVersion).toBe(LEGAL_VERSIONS.terms);
    expect(rows[0].ipAddress).toBe("203.0.113.7");
  });

  test("recordAcceptance stores the organization for org-scoped documents", async () => {
    const userA = await seedUserOrgProject("legal-a");

    await recordAcceptance(userA.userId, "dpa", {
      ipAddress: null,
      userAgent: null,
      organizationId: userA.organizationId,
    });

    const rows = await withUserContext(userA.userId, async (tx) =>
      tx.select().from(legalAcceptances),
    );

    expect(rows.length).toBe(1);
    expect(rows[0].documentType).toBe("dpa");
    expect(rows[0].organizationId).toBe(userA.organizationId);
  });

  test("recordAcceptance truncates an oversized user agent to its cap", async () => {
    const userA = await seedUserOrgProject("legal-a");

    await recordAcceptance(userA.userId, "terms", {
      ipAddress: "203.0.113.7",
      userAgent: "x".repeat(LEGAL_USER_AGENT_MAX_CHARS + 500),
    });

    const rows = await withUserContext(userA.userId, async (tx) =>
      tx.select().from(legalAcceptances),
    );

    expect(rows.length).toBe(1);
    expect(rows[0].userAgent?.length).toBe(LEGAL_USER_AGENT_MAX_CHARS);
  });

  test("a different user cannot read another user's acceptance rows", async () => {
    const userA = await seedUserOrgProject("legal-a");
    const userB = await seedUserOrgProject("legal-b");

    await recordAcceptance(userA.userId, "privacy", {
      ipAddress: null,
      userAgent: null,
    });

    const seenByB = await withUserContext(userB.userId, async (tx) =>
      tx.select().from(legalAcceptances),
    );

    expect(seenByB.length).toBe(0);
  });

  test("WITH CHECK rejects an insert attributed to another user", async () => {
    const userA = await seedUserOrgProject("legal-a");
    const userB = await seedUserOrgProject("legal-b");

    const captured = await captureAppUserError(
      userA.userId,
      (tx) =>
        tx`
        INSERT INTO legal_acceptances (user_id, document_type, document_version)
        VALUES (${userB.userId}, 'terms', ${LEGAL_VERSIONS.terms})
      `,
    );
    expect(captured.code).toBe("42501");

    const rows = await withUserContext(userB.userId, async (tx) =>
      tx.select().from(legalAcceptances),
    );
    expect(rows.length).toBe(0);
  });
});
