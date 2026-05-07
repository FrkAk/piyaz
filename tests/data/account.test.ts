import { test, expect, describe, afterEach } from "bun:test";
import postgres from "postgres";
import { truncateAll } from "@/tests/setup/schema";
import { getConnectionString } from "@/tests/setup/container";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { clearOrgMembershipArtifacts } from "@/lib/data/account";

afterEach(async () => {
  await truncateAll();
});

describe("clearOrgMembershipArtifacts", () => {
  test("wipes session pointer + 3 oauth tables for matching (userId, orgId)", async () => {
    const f = await seedUserOrgProject("clear-match");

    const sqlc = postgres(getConnectionString(), { max: 1 });
    try {
      await sqlc`
        INSERT INTO neon_auth."session" ("expiresAt", "token", "updatedAt", "userId", "activeOrganizationId")
        VALUES (now() + interval '7 days', 'tok-' || gen_random_uuid()::text, now(), ${f.userId}, ${f.organizationId}::text)
      `;
      await sqlc`
        INSERT INTO neon_auth."oauthAccessToken" ("token", "clientId", "userId", "referenceId", "scopes", "expiresAt")
        VALUES ('at-1', 'client-1', ${f.userId}, ${f.organizationId}, '{}', now() + interval '1 hour')
      `;
      await sqlc`
        INSERT INTO neon_auth."oauthRefreshToken" ("token", "clientId", "userId", "referenceId", "scopes", "expiresAt")
        VALUES ('rt-1', 'client-1', ${f.userId}, ${f.organizationId}, '{}', now() + interval '7 days')
      `;
      await sqlc`
        INSERT INTO neon_auth."oauthConsent" ("clientId", "userId", "referenceId", "scopes")
        VALUES ('client-1', ${f.userId}, ${f.organizationId}, '{}')
      `;

      await clearOrgMembershipArtifacts(f.userId, f.organizationId);

      const [{ activePtr }] = await sqlc<{ activePtr: string | null }[]>`
        SELECT "activeOrganizationId" AS "activePtr" FROM neon_auth."session"
        WHERE "userId" = ${f.userId}
        LIMIT 1
      `;
      expect(activePtr).toBeNull();

      const at = await sqlc`SELECT id FROM neon_auth."oauthAccessToken" WHERE "userId" = ${f.userId}`;
      expect(at.length).toBe(0);

      const rt = await sqlc`SELECT id FROM neon_auth."oauthRefreshToken" WHERE "userId" = ${f.userId}`;
      expect(rt.length).toBe(0);

      const cs = await sqlc`SELECT id FROM neon_auth."oauthConsent" WHERE "userId" = ${f.userId}`;
      expect(cs.length).toBe(0);
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  });

  test("does not touch records for other (userId, orgId) pairs", async () => {
    const a = await seedUserOrgProject("clear-iso-a");
    const b = await seedUserOrgProject("clear-iso-b");

    const sqlc = postgres(getConnectionString(), { max: 1 });
    try {
      await sqlc`
        INSERT INTO neon_auth."oauthAccessToken" ("token", "clientId", "userId", "referenceId", "scopes", "expiresAt")
        VALUES
          ('at-a-a', 'client-1', ${a.userId}, ${a.organizationId}, '{}', now() + interval '1 hour'),
          ('at-a-b', 'client-1', ${a.userId}, ${b.organizationId}, '{}', now() + interval '1 hour'),
          ('at-b-a', 'client-1', ${b.userId}, ${a.organizationId}, '{}', now() + interval '1 hour'),
          ('at-b-b', 'client-1', ${b.userId}, ${b.organizationId}, '{}', now() + interval '1 hour')
      `;

      await clearOrgMembershipArtifacts(a.userId, a.organizationId);

      const remaining = await sqlc<{ token: string }[]>`
        SELECT token FROM neon_auth."oauthAccessToken"
        ORDER BY token ASC
      `;
      const tokens = remaining.map((r) => r.token);

      expect(tokens).toEqual(["at-a-b", "at-b-a", "at-b-b"]);
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  });
});
