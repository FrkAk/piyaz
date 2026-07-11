import { afterEach, describe, expect, test } from "bun:test";
import { RECONSENT_PATH, requireLegalConsent } from "@/lib/auth/consent";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";

/**
 * Contract for the web consent gate `requireLegalConsent`: a user with an
 * outstanding personal document is redirected to the interstitial (Next's
 * `redirect()` throws a `NEXT_REDIRECT` control error), and a current user
 * passes through.
 */

afterEach(async () => {
  await truncateAll();
});

describe("requireLegalConsent", () => {
  test("redirects a stale user to the re-acceptance interstitial", async () => {
    const user = await seedUserOrgProject("gate-stale", {
      legalCurrent: false,
    });

    let thrown: unknown;
    try {
      await requireLegalConsent(user.userId);
    } catch (err) {
      thrown = err;
    }
    const digest = (thrown as { digest?: string } | undefined)?.digest ?? "";
    expect(digest).toStartWith("NEXT_REDIRECT");
    expect(digest).toContain(RECONSENT_PATH);
  });

  test("passes a user current on both documents", async () => {
    const user = await seedUserOrgProject("gate-current");

    await requireLegalConsent(user.userId);
  });
});
