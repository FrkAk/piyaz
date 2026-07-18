import { test, expect, describe, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import {
  listMembershipsWithCounts,
  demoteMemberWithGuard,
  guardedRemoveMember,
  guardedLeaveTeam,
  countOwnedOrganizations,
} from "@/lib/data/membership";

const includesOwner = (r: string) => r.includes("owner");

/** Insert a member of `role` into an org, returning `{ userId, memberId }`. */
async function addMember(
  organizationId: string,
  suffix: string,
  role: "owner" | "admin" | "member",
): Promise<{ userId: string; memberId: string }> {
  const sqlc = superuserPool();
  try {
    const [u] = await sqlc<{ id: string }[]>`
      INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
      VALUES (${"U " + suffix}, ${suffix + "@test.local"}, true, now())
      RETURNING id
    `;
    const [m] = await sqlc<{ id: string }[]>`
      INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
      VALUES (${organizationId}, ${u.id}, ${role}, now())
      RETURNING id
    `;
    return { userId: u.id, memberId: m.id };
  } finally {
    await sqlc.end({ timeout: 5 });
  }
}

/** Resolve the seeded owner's member id for a fixture org. */
async function ownerMemberId(
  organizationId: string,
  userId: string,
): Promise<string> {
  const sqlc = superuserPool();
  try {
    const [m] = await sqlc<{ id: string }[]>`
      SELECT id FROM piyaz_auth."member"
      WHERE "organizationId" = ${organizationId} AND "userId" = ${userId}
      LIMIT 1
    `;
    return m.id;
  } finally {
    await sqlc.end({ timeout: 5 });
  }
}

/** Count owner-role members of an org. */
async function ownerCount(organizationId: string): Promise<number> {
  const sqlc = superuserPool();
  try {
    const rows = await sqlc<{ role: string }[]>`
      SELECT role FROM piyaz_auth."member"
      WHERE "organizationId" = ${organizationId}
    `;
    return rows.filter((r) => includesOwner(r.role)).length;
  } finally {
    await sqlc.end({ timeout: 5 });
  }
}

/** Delete a member row via superuser, simulating Better Auth's autocommit write. */
async function deleteMember(memberId: string): Promise<void> {
  const c = superuserPool();
  try {
    await c`DELETE FROM piyaz_auth."member" WHERE id = ${memberId}`;
  } finally {
    await c.end({ timeout: 5 });
  }
}

afterEach(async () => {
  await truncateAll();
});

test("listMembershipsWithCounts paginates by (createdAt, id) cursor", async () => {
  // Seed 1 user with 6 organizations (all owner-membership)
  const base = await seedUserOrgProject("memberpage");

  const sqlc = superuserPool();
  try {
    for (let i = 0; i < 5; i++) {
      const [o] = await sqlc<{ id: string }[]>`
        INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
        VALUES (${"Extra " + i}, ${"extra-" + i}, ${new Date(Date.now() + (i + 1) * 1000)})
        RETURNING id
      `;
      await sqlc`
        INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
        VALUES (${o.id}, ${base.userId}, 'owner', now())
      `;
    }
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const page1 = await listMembershipsWithCounts(base.userId, { limit: 3 });
  expect(page1.memberships.length).toBe(3);
  expect(page1.nextCursor).not.toBeNull();

  const page2 = await listMembershipsWithCounts(base.userId, {
    limit: 3,
    cursor: page1.nextCursor,
  });
  expect(page2.memberships.length).toBe(3);
  expect(page2.nextCursor).toBeNull();

  const ids1 = new Set(page1.memberships.map((m) => m.organizationId));
  const ids2 = new Set(page2.memberships.map((m) => m.organizationId));
  for (const id of ids2) expect(ids1.has(id)).toBe(false);
  expect(ids1.size + ids2.size).toBe(6);
});

describe("demoteMemberWithGuard", () => {
  test("returns ok when demoting an admin who isn't the last owner", async () => {
    const f = await seedUserOrgProject("demote-ok");
    const sqlc = superuserPool();
    let secondMemberId: string;
    try {
      const [u] = await sqlc<{ id: string }[]>`
        INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
        VALUES ('Second', 'second-demote-ok@test.local', true, now())
        RETURNING id
      `;
      const [m] = await sqlc<{ id: string }[]>`
        INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
        VALUES (${f.organizationId}, ${u.id}, 'admin', now())
        RETURNING id
      `;
      secondMemberId = m.id;
    } finally {
      await sqlc.end({ timeout: 5 });
    }

    let demoteCalled = false;
    const outcome = await demoteMemberWithGuard(
      f.userId,
      {
        organizationId: f.organizationId,
        memberId: secondMemberId,
        role: "member",
        roleIncludesOwner: (r: string) => r.includes("owner"),
      },
      async () => {
        demoteCalled = true;
      },
    );

    expect(outcome.kind).toBe("ok");
    expect(demoteCalled).toBe(true);
  });

  test("returns fail/not_found for an unknown member id", async () => {
    const f = await seedUserOrgProject("demote-notfound");
    let demoteCalled = false;
    const outcome = await demoteMemberWithGuard(
      f.userId,
      {
        organizationId: f.organizationId,
        memberId: "00000000-0000-0000-0000-000000000000",
        role: "member",
        roleIncludesOwner: (r: string) => r.includes("owner"),
      },
      async () => {
        demoteCalled = true;
      },
    );

    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") expect(outcome.code).toBe("not_found");
    expect(demoteCalled).toBe(false);
  });

  test("returns fail/not_found when target member is in a team the caller can't see (anti-enumeration)", async () => {
    const a = await seedUserOrgProject("demote-cross-a");
    const b = await seedUserOrgProject("demote-cross-b");

    const sqlc = superuserPool();
    let bMemberId: string;
    try {
      const [m] = await sqlc<{ id: string }[]>`
        SELECT id FROM piyaz_auth."member"
        WHERE "organizationId" = ${b.organizationId} AND "userId" = ${b.userId}
        LIMIT 1
      `;
      bMemberId = m.id;
    } finally {
      await sqlc.end({ timeout: 5 });
    }

    let demoteCalled = false;
    const outcome = await demoteMemberWithGuard(
      a.userId,
      {
        organizationId: a.organizationId,
        memberId: bMemberId,
        role: "member",
        roleIncludesOwner: (r: string) => r.includes("owner"),
      },
      async () => {
        demoteCalled = true;
      },
    );

    // `current_user_visible_member` returns null for both "doesn't exist"
    // and "exists but caller isn't a member" (anti-enumeration). Callers
    // see `not_found` for both. `forbidden` is reserved for the
    // mismatched-organizationId tampering path, not exercised here.
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") expect(outcome.code).toBe("not_found");
    expect(demoteCalled).toBe(false);
  });

  test("last-owner guard blocks demoting the only owner", async () => {
    const f = await seedUserOrgProject("demote-lastowner");
    const sqlc = superuserPool();
    let memberId: string;
    try {
      const [m] = await sqlc<{ id: string }[]>`
        SELECT id FROM piyaz_auth."member"
        WHERE "organizationId" = ${f.organizationId} AND "userId" = ${f.userId}
        LIMIT 1
      `;
      memberId = m.id;
    } finally {
      await sqlc.end({ timeout: 5 });
    }

    let demoteCalled = false;
    const outcome = await demoteMemberWithGuard(
      f.userId,
      {
        organizationId: f.organizationId,
        memberId,
        role: "member",
        roleIncludesOwner: (r: string) => r.includes("owner"),
      },
      async () => {
        demoteCalled = true;
      },
    );

    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail")
      expect(outcome.code).toBe("cannot_leave_only_owner");
    expect(demoteCalled).toBe(false);
  });

  test("last-owner guard serializes concurrent demotes — only one of two owners gets demoted", async () => {
    const f = await seedUserOrgProject("demote-race");
    const sqlc = superuserPool();
    let firstMemberId: string;
    let secondMemberId: string;
    try {
      const [m1] = await sqlc<{ id: string }[]>`
        SELECT id FROM piyaz_auth."member"
        WHERE "organizationId" = ${f.organizationId} AND "userId" = ${f.userId}
        LIMIT 1
      `;
      firstMemberId = m1.id;

      const [u] = await sqlc<{ id: string }[]>`
        INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
        VALUES ('Second Owner', 'second-owner-race@test.local', true, now())
        RETURNING id
      `;
      const [m2] = await sqlc<{ id: string }[]>`
        INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
        VALUES (${f.organizationId}, ${u.id}, 'owner', now())
        RETURNING id
      `;
      secondMemberId = m2.id;
    } finally {
      await sqlc.end({ timeout: 5 });
    }

    const performDemote = async (memberId: string) => {
      const c = superuserPool();
      try {
        await c`
          UPDATE piyaz_auth."member"
          SET role = 'member'
          WHERE id = ${memberId}
        `;
      } finally {
        await c.end({ timeout: 5 });
      }
    };

    const [outcome1, outcome2] = await Promise.all([
      demoteMemberWithGuard(
        f.userId,
        {
          organizationId: f.organizationId,
          memberId: firstMemberId,
          role: "member",
          roleIncludesOwner: (r: string) => r.includes("owner"),
        },
        () => performDemote(firstMemberId),
      ),
      demoteMemberWithGuard(
        f.userId,
        {
          organizationId: f.organizationId,
          memberId: secondMemberId,
          role: "member",
          roleIncludesOwner: (r: string) => r.includes("owner"),
        },
        () => performDemote(secondMemberId),
      ),
    ]);

    const oks = [outcome1, outcome2].filter((o) => o.kind === "ok");
    const lastOwnerFails = [outcome1, outcome2].filter(
      (o) => o.kind === "fail" && o.code === "cannot_leave_only_owner",
    );
    expect(oks.length).toBe(1);
    expect(lastOwnerFails.length).toBe(1);
  });
});

describe("countOwnedOrganizations", () => {
  test("counts only owner-role memberships", async () => {
    const f = await seedUserOrgProject("owned-count");
    const sqlc = superuserPool();
    try {
      for (let i = 0; i < 2; i++) {
        const [o] = await sqlc<{ id: string }[]>`
          INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
          VALUES (${"Owned " + i}, ${"owned-" + i}, now())
          RETURNING id
        `;
        await sqlc`
          INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
          VALUES (${o.id}, ${f.userId}, 'owner', now())
        `;
      }
      const [adminOrg] = await sqlc<{ id: string }[]>`
        INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
        VALUES ('Admin Org', 'admin-org', now())
        RETURNING id
      `;
      await sqlc`
        INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
        VALUES (${adminOrg.id}, ${f.userId}, 'admin', now())
      `;
    } finally {
      await sqlc.end({ timeout: 5 });
    }

    expect(await countOwnedOrganizations(f.userId)).toBe(3);
  });
});

describe("guardedRemoveMember", () => {
  test("removes a non-owner member", async () => {
    const f = await seedUserOrgProject("rm-ok");
    const second = await addMember(f.organizationId, "rm-ok-2", "member");

    let removeCalled = false;
    const outcome = await guardedRemoveMember(
      f.userId,
      {
        organizationId: f.organizationId,
        memberIdOrEmail: second.memberId,
        roleIncludesOwner: includesOwner,
      },
      async () => {
        removeCalled = true;
      },
    );

    expect(outcome.kind).toBe("ok");
    expect(removeCalled).toBe(true);
  });

  test("blocks removing the only owner", async () => {
    const f = await seedUserOrgProject("rm-lastowner");
    const memberId = await ownerMemberId(f.organizationId, f.userId);

    let removeCalled = false;
    const outcome = await guardedRemoveMember(
      f.userId,
      {
        organizationId: f.organizationId,
        memberIdOrEmail: memberId,
        roleIncludesOwner: includesOwner,
      },
      async () => {
        removeCalled = true;
      },
    );

    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail")
      expect(outcome.code).toBe("cannot_leave_only_owner");
    expect(removeCalled).toBe(false);
  });

  test("serializes concurrent removal of two owners — one survives", async () => {
    const f = await seedUserOrgProject("rm-race");
    const o1 = await ownerMemberId(f.organizationId, f.userId);
    const o2 = await addMember(f.organizationId, "rm-race-2", "owner");
    // A stable admin actor keeps RLS visibility while both owners are targeted.
    const admin = await addMember(f.organizationId, "rm-race-admin", "admin");

    const [outcome1, outcome2] = await Promise.all([
      guardedRemoveMember(
        admin.userId,
        {
          organizationId: f.organizationId,
          memberIdOrEmail: o1,
          roleIncludesOwner: includesOwner,
        },
        () => deleteMember(o1),
      ),
      guardedRemoveMember(
        admin.userId,
        {
          organizationId: f.organizationId,
          memberIdOrEmail: o2.memberId,
          roleIncludesOwner: includesOwner,
        },
        () => deleteMember(o2.memberId),
      ),
    ]);

    const oks = [outcome1, outcome2].filter((o) => o.kind === "ok");
    const fails = [outcome1, outcome2].filter(
      (o) => o.kind === "fail" && o.code === "cannot_leave_only_owner",
    );
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect(await ownerCount(f.organizationId)).toBe(1);
  });

  test("proceeds for an email target when >1 owner remains", async () => {
    const f = await seedUserOrgProject("rm-email-ok");
    await addMember(f.organizationId, "rm-email-ok-2", "owner");

    let removeCalled = false;
    const outcome = await guardedRemoveMember(
      f.userId,
      {
        organizationId: f.organizationId,
        memberIdOrEmail: "someone@test.local",
        roleIncludesOwner: includesOwner,
      },
      async () => {
        removeCalled = true;
      },
    );

    expect(outcome.kind).toBe("ok");
    expect(removeCalled).toBe(true);
  });

  test("fails closed for an unresolvable email target in a single-owner team", async () => {
    const f = await seedUserOrgProject("rm-email-block");

    let removeCalled = false;
    const outcome = await guardedRemoveMember(
      f.userId,
      {
        organizationId: f.organizationId,
        memberIdOrEmail: "someone@test.local",
        roleIncludesOwner: includesOwner,
      },
      async () => {
        removeCalled = true;
      },
    );

    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail")
      expect(outcome.code).toBe("cannot_leave_only_owner");
    expect(removeCalled).toBe(false);
  });
});

describe("guardedLeaveTeam", () => {
  test("lets a non-owner leave", async () => {
    const f = await seedUserOrgProject("leave-ok");
    const member = await addMember(f.organizationId, "leave-ok-2", "member");

    let leaveCalled = false;
    const outcome = await guardedLeaveTeam(
      member.userId,
      { organizationId: f.organizationId, roleIncludesOwner: includesOwner },
      async () => {
        leaveCalled = true;
      },
    );

    expect(outcome.kind).toBe("ok");
    expect(leaveCalled).toBe(true);
  });

  test("blocks the sole owner from leaving", async () => {
    const f = await seedUserOrgProject("leave-lastowner");

    let leaveCalled = false;
    const outcome = await guardedLeaveTeam(
      f.userId,
      { organizationId: f.organizationId, roleIncludesOwner: includesOwner },
      async () => {
        leaveCalled = true;
      },
    );

    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail")
      expect(outcome.code).toBe("cannot_leave_only_owner");
    expect(leaveCalled).toBe(false);
  });

  test("serializes a leave racing a remove of the other owner — one survives", async () => {
    const f = await seedUserOrgProject("leave-race");
    const o1 = f.userId;
    const o2 = await addMember(f.organizationId, "leave-race-2", "owner");
    const admin = await addMember(
      f.organizationId,
      "leave-race-admin",
      "admin",
    );
    const o1MemberId = await ownerMemberId(f.organizationId, o1);

    const [leaveOutcome, removeOutcome] = await Promise.all([
      guardedLeaveTeam(
        o1,
        { organizationId: f.organizationId, roleIncludesOwner: includesOwner },
        () => deleteMember(o1MemberId),
      ),
      guardedRemoveMember(
        admin.userId,
        {
          organizationId: f.organizationId,
          memberIdOrEmail: o2.memberId,
          roleIncludesOwner: includesOwner,
        },
        () => deleteMember(o2.memberId),
      ),
    ]);

    const outcomes = [leaveOutcome, removeOutcome];
    const oks = outcomes.filter((o) => o.kind === "ok");
    const fails = outcomes.filter(
      (o) => o.kind === "fail" && o.code === "cannot_leave_only_owner",
    );
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
    expect(await ownerCount(f.organizationId)).toBe(1);
  });
});
