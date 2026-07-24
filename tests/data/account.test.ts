import { test, expect, describe, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask } from "@/lib/data/task";
import { broker } from "@/lib/realtime/broker";
import {
  clearOrgMembershipArtifacts,
  enumerateOwnedOrgsForDeletion,
  exportAccountData,
  getPasswordUpdatedAt,
  getWhoami,
  planOwnedOrgDeletion,
  scrubLegalAcceptances,
} from "@/lib/data/account";

/**
 * Insert a bare user row and return its id.
 *
 * @param sql - Superuser client.
 * @param suffix - Unique suffix for name/email.
 * @returns The new user id.
 */
async function insertUser(
  sql: ReturnType<typeof superuserPool>,
  suffix: string,
): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
    VALUES (${"User " + suffix}, ${"user" + suffix + "@test.local"}, true, now())
    RETURNING id
  `;
  return u.id;
}

/**
 * Insert a membership row.
 *
 * @param sql - Superuser client.
 * @param orgId - Organization id.
 * @param userId - Member user id.
 * @param role - Member role string.
 */
async function insertMember(
  sql: ReturnType<typeof superuserPool>,
  orgId: string,
  userId: string,
  role: string,
): Promise<void> {
  await sql`
    INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
    VALUES (${orgId}, ${userId}, ${role}, now())
  `;
}

/**
 * Insert a legal-acceptance row.
 *
 * @param sql - Superuser client.
 * @param userId - Owner user id.
 * @param overrides - Optional field overrides.
 */
async function insertAcceptance(
  sql: ReturnType<typeof superuserPool>,
  userId: string,
  overrides: {
    documentType?: string;
    documentVersion?: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  } = {},
): Promise<void> {
  const {
    documentType = "terms",
    documentVersion = "2026-01-01",
    ipAddress = "203.0.113.7",
    userAgent = "Mozilla/5.0 test",
  } = overrides;
  await sql`
    INSERT INTO public.legal_acceptances
      ("user_id", "document_type", "document_version", "ip_address", "user_agent")
    VALUES (${userId}, ${documentType}, ${documentVersion}, ${ipAddress}, ${userAgent})
  `;
}

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
    const f = await seedUserOrgProject("pw-updated-at", {
      legalCurrent: false,
    });
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
    const f = await seedUserOrgProject("pw-no-credential", {
      legalCurrent: false,
    });
    expect(await getPasswordUpdatedAt(f.userId)).toBeNull();
  });
});

describe("clearOrgMembershipArtifacts", () => {
  test("wipes session pointer + 3 oauth tables for matching (userId, orgId)", async () => {
    const f = await seedUserOrgProject("clear-match", { legalCurrent: false });

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
    const a = await seedUserOrgProject("clear-iso-a", { legalCurrent: false });
    const b = await seedUserOrgProject("clear-iso-b", { legalCurrent: false });

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

  test("bumps the content clock on tasks that lose an assignee", async () => {
    const f = await seedUserOrgProject("clear-clocks", { legalCurrent: false });
    const ctx = makeAuthContext(f.userId);
    const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

    const sqlc = superuserPool();
    try {
      await sqlc`
        INSERT INTO task_assignees ("task_id", "user_id")
        VALUES (${task.id}, ${f.userId})
      `;
      const [before] = await sqlc<{ u: number }[]>`
        SELECT extract(epoch FROM updated_at)::float8 AS u
        FROM tasks WHERE id = ${task.id}
      `;
      const [beforeProj] = await sqlc<{ u: number }[]>`
        SELECT extract(epoch FROM updated_at)::float8 AS u
        FROM projects WHERE id = ${f.projectId}
      `;
      await new Promise((r) => setTimeout(r, 50));

      const frames: string[] = [];
      broker.attach(f.userId, {
        send: (data) => frames.push(data),
        close: () => {},
      });
      broker.register(f.userId, `project:${f.projectId}`);

      await clearOrgMembershipArtifacts(f.userId, f.organizationId);

      const [{ n }] = await sqlc<{ n: number }[]>`
        SELECT count(*)::int AS n FROM task_assignees
        WHERE task_id = ${task.id}
      `;
      expect(n).toBe(0);
      const [after] = await sqlc<{ u: number }[]>`
        SELECT extract(epoch FROM updated_at)::float8 AS u
        FROM tasks WHERE id = ${task.id}
      `;
      expect(after.u).toBeGreaterThan(before.u);
      const [afterProj] = await sqlc<{ u: number }[]>`
        SELECT extract(epoch FROM updated_at)::float8 AS u
        FROM projects WHERE id = ${f.projectId}
      `;
      expect(afterProj.u).toBeGreaterThan(beforeProj.u);

      const projectEvents = frames
        .map(
          (fr) =>
            JSON.parse(fr.slice("data: ".length)) as {
              kind: string;
              projectId?: string;
            },
        )
        .filter((e) => e.kind === "project");
      expect(projectEvents.map((e) => e.projectId)).toContain(f.projectId);
    } finally {
      broker._resetForTests();
      await sqlc.end({ timeout: 5 });
    }
  });
});

describe("getWhoami", () => {
  test("returns the caller's own id, name, and email", async () => {
    const f = await seedUserOrgProject("whoami-self", { legalCurrent: false });
    const who = await getWhoami(makeAuthContext(f.userId));
    expect(who).toEqual({
      userId: f.userId,
      name: "User whoami-self",
      email: "userwhoami-self@test.local",
    });
  });

  test("never discloses another user's row", async () => {
    const a = await seedUserOrgProject("whoami-a", { legalCurrent: false });
    const b = await seedUserOrgProject("whoami-b", { legalCurrent: false });
    const who = await getWhoami(makeAuthContext(a.userId));
    expect(who.userId).toBe(a.userId);
    expect(who.userId).not.toBe(b.userId);
    expect(who.email).toBe("userwhoami-a@test.local");
  });
});

describe("scrubLegalAcceptances", () => {
  test("nulls ip/user-agent and retains document evidence", async () => {
    const f = await seedUserOrgProject("scrub-basic", { legalCurrent: false });
    const sqlc = superuserPool();
    await insertAcceptance(sqlc, f.userId, {
      documentType: "terms",
      documentVersion: "2026-02-02",
    });
    await insertAcceptance(sqlc, f.userId, {
      documentType: "privacy",
      documentVersion: "2026-02-02",
    });

    await scrubLegalAcceptances(f.userId);

    const rows = await sqlc<
      {
        document_type: string;
        document_version: string;
        ip_address: string | null;
        user_agent: string | null;
        accepted_at: Date;
      }[]
    >`
      SELECT document_type, document_version, ip_address, user_agent, accepted_at
      FROM public.legal_acceptances
      WHERE user_id = ${f.userId}
      ORDER BY document_type ASC
    `;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.ip_address).toBeNull();
      expect(row.user_agent).toBeNull();
      expect(row.document_version).toBe("2026-02-02");
      expect(row.accepted_at).toBeInstanceOf(Date);
    }
    expect(rows.map((r) => r.document_type)).toEqual(["privacy", "terms"]);
  });

  test("zero acceptance rows is a valid success", async () => {
    const f = await seedUserOrgProject("scrub-empty", { legalCurrent: false });
    await expect(scrubLegalAcceptances(f.userId)).resolves.toBeUndefined();
  });

  test("only scrubs the target user's rows", async () => {
    const a = await seedUserOrgProject("scrub-iso-a", { legalCurrent: false });
    const b = await seedUserOrgProject("scrub-iso-b", { legalCurrent: false });
    const sqlc = superuserPool();
    await insertAcceptance(sqlc, a.userId, { ipAddress: "10.0.0.1" });
    await insertAcceptance(sqlc, b.userId, { ipAddress: "10.0.0.2" });

    await scrubLegalAcceptances(a.userId);

    const [bRow] = await sqlc<{ ip_address: string | null }[]>`
      SELECT ip_address FROM public.legal_acceptances WHERE user_id = ${b.userId}
    `;
    expect(bRow.ip_address).toBe("10.0.0.2");
  });
});

describe("exportAccountData", () => {
  test("returns the caller's profile, memberships, and acceptances", async () => {
    const f = await seedUserOrgProject("export-self", { legalCurrent: false });
    const sqlc = superuserPool();
    await insertAcceptance(sqlc, f.userId, {
      documentType: "terms",
      ipAddress: "198.51.100.5",
      userAgent: "ExportUA",
    });

    const data = await exportAccountData(f.userId);

    expect(data.profile.userId).toBe(f.userId);
    expect(data.profile.email).toBe("userexport-self@test.local");
    expect(data.memberships.map((m) => m.organizationId)).toEqual([
      f.organizationId,
    ]);
    expect(data.memberships[0]?.role).toBe("owner");
    expect(data.legalAcceptances.length).toBe(1);
    expect(data.legalAcceptances[0]).toMatchObject({
      documentType: "terms",
      ipAddress: "198.51.100.5",
      userAgent: "ExportUA",
    });
    expect(typeof data.exportedAt).toBe("string");
  });

  test("never includes another member's data from a shared team", async () => {
    const a = await seedUserOrgProject("export-shared-a", {
      legalCurrent: false,
    });
    const sqlc = superuserPool();
    const b = await insertUser(sqlc, "export-shared-b");
    await insertMember(sqlc, a.organizationId, b, "member");
    await insertAcceptance(sqlc, a.userId, { ipAddress: "192.0.2.10" });
    await insertAcceptance(sqlc, b, { ipAddress: "192.0.2.20" });

    const data = await exportAccountData(a.userId);

    expect(data.profile.userId).toBe(a.userId);
    expect(data.profile.email).not.toContain("export-shared-b");
    expect(data.legalAcceptances.length).toBe(1);
    expect(data.legalAcceptances[0]?.ipAddress).toBe("192.0.2.10");
  });
});

describe("enumerateOwnedOrgsForDeletion + planOwnedOrgDeletion", () => {
  test("blocks when the caller solely owns a team with other members", async () => {
    const f = await seedUserOrgProject("plan-sole-owner", {
      legalCurrent: false,
    });
    const sqlc = superuserPool();
    const other = await insertUser(sqlc, "plan-sole-owner-member");
    await insertMember(sqlc, f.organizationId, other, "member");

    const owned = await enumerateOwnedOrgsForDeletion(f.userId);
    expect(owned).toEqual([
      { orgId: f.organizationId, memberCount: 2, ownerCount: 1 },
    ]);
    expect(planOwnedOrgDeletion(owned)).toEqual({
      kind: "blocked",
      orgId: f.organizationId,
    });
  });

  test("marks a solely-owned memberless team for deletion", async () => {
    const f = await seedUserOrgProject("plan-memberless", {
      legalCurrent: false,
    });

    const owned = await enumerateOwnedOrgsForDeletion(f.userId);
    expect(owned).toEqual([
      { orgId: f.organizationId, memberCount: 1, ownerCount: 1 },
    ]);
    expect(planOwnedOrgDeletion(owned)).toEqual({
      kind: "ok",
      orgIdsToDelete: [f.organizationId],
    });
  });

  test("leaves a co-owned team untouched", async () => {
    const f = await seedUserOrgProject("plan-co-owned", {
      legalCurrent: false,
    });
    const sqlc = superuserPool();
    const coOwner = await insertUser(sqlc, "plan-co-owner-2");
    const member = await insertUser(sqlc, "plan-co-owner-member");
    await insertMember(sqlc, f.organizationId, coOwner, "owner");
    await insertMember(sqlc, f.organizationId, member, "member");

    const owned = await enumerateOwnedOrgsForDeletion(f.userId);
    expect(owned).toEqual([
      { orgId: f.organizationId, memberCount: 3, ownerCount: 2 },
    ]);
    expect(planOwnedOrgDeletion(owned)).toEqual({
      kind: "ok",
      orgIdsToDelete: [],
    });
  });

  test("excludes teams where the caller is not an owner", async () => {
    const owner = await seedUserOrgProject("plan-not-owner-owner", {
      legalCurrent: false,
    });
    const sqlc = superuserPool();
    const member = await insertUser(sqlc, "plan-not-owner-member");
    await insertMember(sqlc, owner.organizationId, member, "member");

    const owned = await enumerateOwnedOrgsForDeletion(member);
    expect(owned).toEqual([]);
    expect(planOwnedOrgDeletion(owned)).toEqual({
      kind: "ok",
      orgIdsToDelete: [],
    });
  });
});
