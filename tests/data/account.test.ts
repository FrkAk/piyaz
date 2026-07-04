import { test, expect, describe, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import {
  clearOrgMembershipArtifacts,
  getPasswordUpdatedAt,
  getWhoami,
} from "@/lib/data/account";

afterEach(async () => {
  await truncateAll();
});

describe("getPasswordUpdatedAt", () => {
  // Regression: the helper must read through authDb (auth_role).
  // docker/grants-auth.sql deliberately excludes piyaz_auth.account (password
  // hashes) from service_role's grants, so a serviceRoleDb read throws
  // "permission denied for table account" at runtime. These tests run
  // against the real role split and fail on any client downgrade.
  test("returns the credential row's updatedAt", async () => {
    const f = await seedUserOrgProject("pw-updated-at");
    const sqlc = superuserPool();
    await sqlc`
      INSERT INTO piyaz_auth."account"
        ("accountId", "providerId", "userId", "password", "updatedAt")
      VALUES (${f.userId}, 'credential', ${f.userId},
              'scrypt-hash-placeholder', '2026-03-01T12:00:00Z')
    `;

    const updatedAt = await getPasswordUpdatedAt(f.userId);
    expect(updatedAt).toEqual(new Date("2026-03-01T12:00:00Z"));
  });

  test("returns null for a user without a password-bearing account", async () => {
    const f = await seedUserOrgProject("pw-no-credential");
    expect(await getPasswordUpdatedAt(f.userId)).toBeNull();
  });
});

describe("clearOrgMembershipArtifacts", () => {
  test("wipes session pointer + 3 oauth tables for matching (userId, orgId)", async () => {
    const f = await seedUserOrgProject("clear-match");

    const sqlc = superuserPool();
    try {
      await sqlc`
        INSERT INTO piyaz_auth."session" ("expiresAt", "token", "updatedAt", "userId", "activeOrganizationId")
        VALUES (now() + interval '7 days', 'tok-' || gen_random_uuid()::text, now(), ${f.userId}, ${f.organizationId}::text)
      `;
      await sqlc`
        INSERT INTO piyaz_auth."oauthAccessToken" ("token", "clientId", "userId", "referenceId", "scopes", "expiresAt")
        VALUES ('at-1', 'client-1', ${f.userId}, ${f.organizationId}, '{}', now() + interval '1 hour')
      `;
      await sqlc`
        INSERT INTO piyaz_auth."oauthRefreshToken" ("token", "clientId", "userId", "referenceId", "scopes", "expiresAt")
        VALUES ('rt-1', 'client-1', ${f.userId}, ${f.organizationId}, '{}', now() + interval '7 days')
      `;
      await sqlc`
        INSERT INTO piyaz_auth."oauthConsent" ("clientId", "userId", "referenceId", "scopes")
        VALUES ('client-1', ${f.userId}, ${f.organizationId}, '{}')
      `;

      await clearOrgMembershipArtifacts(f.userId, f.organizationId);

      const [{ activePtr }] = await sqlc<{ activePtr: string | null }[]>`
        SELECT "activeOrganizationId" AS "activePtr" FROM piyaz_auth."session"
        WHERE "userId" = ${f.userId}
        LIMIT 1
      `;
      expect(activePtr).toBeNull();

      const at =
        await sqlc`SELECT id FROM piyaz_auth."oauthAccessToken" WHERE "userId" = ${f.userId}`;
      expect(at.length).toBe(0);

      const rt =
        await sqlc`SELECT id FROM piyaz_auth."oauthRefreshToken" WHERE "userId" = ${f.userId}`;
      expect(rt.length).toBe(0);

      const cs =
        await sqlc`SELECT id FROM piyaz_auth."oauthConsent" WHERE "userId" = ${f.userId}`;
      expect(cs.length).toBe(0);
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  });

  test("does not touch records for other (userId, orgId) pairs", async () => {
    const a = await seedUserOrgProject("clear-iso-a");
    const b = await seedUserOrgProject("clear-iso-b");

    const sqlc = superuserPool();
    try {
      await sqlc`
        INSERT INTO piyaz_auth."oauthAccessToken" ("token", "clientId", "userId", "referenceId", "scopes", "expiresAt")
        VALUES
          ('at-a-a', 'client-1', ${a.userId}, ${a.organizationId}, '{}', now() + interval '1 hour'),
          ('at-a-b', 'client-1', ${a.userId}, ${b.organizationId}, '{}', now() + interval '1 hour'),
          ('at-b-a', 'client-1', ${b.userId}, ${a.organizationId}, '{}', now() + interval '1 hour'),
          ('at-b-b', 'client-1', ${b.userId}, ${b.organizationId}, '{}', now() + interval '1 hour')
      `;

      await clearOrgMembershipArtifacts(a.userId, a.organizationId);

      const remaining = await sqlc<{ token: string }[]>`
        SELECT token FROM piyaz_auth."oauthAccessToken"
        ORDER BY token ASC
      `;
      const tokens = remaining.map((r) => r.token);

      expect(tokens).toEqual(["at-a-b", "at-b-a", "at-b-b"]);
    } finally {
      await sqlc.end({ timeout: 5 });
    }
  });
});

describe("getWhoami", () => {
  test("returns the caller's own id, name, and email", async () => {
    const f = await seedUserOrgProject("whoami-self");
    const who = await getWhoami(makeAuthContext(f.userId));
    expect(who).toEqual({
      userId: f.userId,
      name: "User whoami-self",
      email: "userwhoami-self@test.local",
    });
  });

  test("never discloses another user's row", async () => {
    const a = await seedUserOrgProject("whoami-a");
    const b = await seedUserOrgProject("whoami-b");
    const who = await getWhoami(makeAuthContext(a.userId));
    expect(who.userId).toBe(a.userId);
    expect(who.userId).not.toBe(b.userId);
    expect(who.email).toBe("userwhoami-a@test.local");
  });
});
