import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { getConnectionString } from "@/tests/setup/global";
import { makeAuthContext } from "@/lib/auth/context";
import {
  createTeamInviteCode,
  findTeamInviteCode,
  revokeTeamInviteCode,
  rotateTeamInviteCode,
} from "@/lib/data/team-invite-code";

/**
 * Targeted RLS coverage for the 4 team-invite-code admin helpers
 * (`findTeamInviteCode`, `createTeamInviteCode`, `rotateTeamInviteCode`,
 * `revokeTeamInviteCode`). They don't traverse
 * `assertProjectAccess`/`assertTaskAccess`, so they're the cleanest
 * probe for "this helper opens its own `withUserContext` frame":
 * without that frame the call would default-deny under app_user.
 *
 * Cross-team assertions pin the policy USING predicate (team B's admin
 * cannot see or mutate team A's invite-code row) at the data-ring
 * surface. Happy-path assertions pin the WITH CHECK predicate on the
 * write helpers.
 */

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set; tests/setup/global.ts didn't run");
  }
});

afterEach(async () => {
  await truncateAll();
});

describe("RLS data-ring discipline — withUserContext wrappers", () => {
  test("findTeamInviteCode succeeds under app_user (uses withUserContext)", async () => {
    const fx = await seedUserOrgProject("dr-find");

    // Seed an existing invite code via the superuser bypass.
    const seedSql = postgres(getConnectionString(), { max: 1 });
    try {
      await seedSql`
        INSERT INTO team_invite_code (organization_id, code, created_by)
        VALUES (${fx.organizationId}, ${"SEED-FIND-CODE"}, ${fx.userId})
      `;
    } finally {
      await seedSql.end({ timeout: 5 });
    }

    const row = await findTeamInviteCode(fx.organizationId, fx.userId);

    expect(row).not.toBeNull();
    expect(row?.code).toBe("SEED-FIND-CODE");
  });

  test("findTeamInviteCode returns null under app_user when GUC user is cross-team", async () => {
    const teamA = await seedUserOrgProject("dr-find-a");
    const teamB = await seedUserOrgProject("dr-find-b");

    const seedSql = postgres(getConnectionString(), { max: 1 });
    try {
      await seedSql`
        INSERT INTO team_invite_code (organization_id, code, created_by)
        VALUES (${teamA.organizationId}, ${"TEAM-A-CODE"}, ${teamA.userId})
      `;
    } finally {
      await seedSql.end({ timeout: 5 });
    }

    // teamB's admin should NOT see teamA's invite-code row. The policy
    // joins through neon_auth.member, which has no (teamA.org, teamB.user)
    // pairing, so the USING predicate filters the row out.
    const leak = await findTeamInviteCode(teamA.organizationId, teamB.userId);

    expect(leak).toBeNull();
  });

  test("createTeamInviteCode succeeds under app_user (uses withUserContext)", async () => {
    const fx = await seedUserOrgProject("dr-create");

    const created = await createTeamInviteCode({
      organizationId: fx.organizationId,
      code: "NEW-CREATE-CODE",
      createdBy: fx.userId,
    });

    expect(created.code).toBe("NEW-CREATE-CODE");
    expect(created.organizationId).toBe(fx.organizationId);

    // Confirm the row really landed (read via the superuser bypass to
    // sidestep the policy and prove the write itself happened).
    const verify = postgres(getConnectionString(), { max: 1 });
    try {
      const rows =
        await verify<{ code: string }[]>`SELECT code FROM team_invite_code WHERE organization_id = ${fx.organizationId}`;
      expect(rows.length).toBe(1);
      expect(rows[0].code).toBe("NEW-CREATE-CODE");
    } finally {
      await verify.end({ timeout: 5 });
    }
  });

  test("rotateTeamInviteCode succeeds under app_user (uses withUserContext)", async () => {
    const fx = await seedUserOrgProject("dr-rotate");

    const seedSql = postgres(getConnectionString(), { max: 1 });
    try {
      await seedSql`
        INSERT INTO team_invite_code (organization_id, code, created_by, use_count)
        VALUES (${fx.organizationId}, ${"OLD-ROTATE-CODE"}, ${fx.userId}, 3)
      `;
    } finally {
      await seedSql.end({ timeout: 5 });
    }

    const rotated = await rotateTeamInviteCode({
      organizationId: fx.organizationId,
      newCode: "NEW-ROTATE-CODE",
      adminUserId: fx.userId,
    });

    expect(rotated).not.toBeNull();
    expect(rotated?.code).toBe("NEW-ROTATE-CODE");
    expect(rotated?.useCount).toBe(0);
    expect(rotated?.revokedAt).toBeNull();
  });

  test("revokeTeamInviteCode succeeds under app_user (uses withUserContext)", async () => {
    const fx = await seedUserOrgProject("dr-revoke");

    const seedSql = postgres(getConnectionString(), { max: 1 });
    try {
      await seedSql`
        INSERT INTO team_invite_code (organization_id, code, created_by)
        VALUES (${fx.organizationId}, ${"REVOKE-ME"}, ${fx.userId})
      `;
    } finally {
      await seedSql.end({ timeout: 5 });
    }

    const revoked = await revokeTeamInviteCode(fx.organizationId, fx.userId);

    expect(revoked).not.toBeNull();
    expect(revoked?.revokedAt).not.toBeNull();
  });

  test("rotateTeamInviteCode under app_user with cross-team GUC mutates zero rows", async () => {
    const teamA = await seedUserOrgProject("dr-cross-a");
    const teamB = await seedUserOrgProject("dr-cross-b");

    const seedSql = postgres(getConnectionString(), { max: 1 });
    try {
      await seedSql`
        INSERT INTO team_invite_code (organization_id, code, created_by)
        VALUES (${teamA.organizationId}, ${"TEAM-A-ROTATE"}, ${teamA.userId})
      `;
    } finally {
      await seedSql.end({ timeout: 5 });
    }

    // Driving rotateTeamInviteCode against teamA's org with teamB's
    // admin user as the GUC must NOT mutate teamA's row — the policy
    // USING predicate filters the UPDATE's target out.
    const rotated = await rotateTeamInviteCode({
      organizationId: teamA.organizationId,
      newCode: "LEAKED-ROTATE",
      adminUserId: teamB.userId,
    });

    expect(rotated).toBeNull();

    // Confirm teamA's row is unchanged.
    const verify = postgres(getConnectionString(), { max: 1 });
    try {
      const rows =
        await verify<{ code: string }[]>`SELECT code FROM team_invite_code WHERE organization_id = ${teamA.organizationId}`;
      expect(rows.length).toBe(1);
      expect(rows[0].code).toBe("TEAM-A-ROTATE");
    } finally {
      await verify.end({ timeout: 5 });
    }
  });

  test("AuthContext factory still mints expected userId shape", () => {
    // Smoke check that the AuthContext brand contract hasn't drifted —
    // the team-invite-code helpers don't take an AuthContext directly
    // (they take adminUserId), but the wider edge/project helpers do,
    // and they accept any value minted by makeAuthContext.
    const ctx = makeAuthContext("00000000-0000-0000-0000-000000000001");
    expect(ctx.userId).toBe("00000000-0000-0000-0000-000000000001");
  });
});
