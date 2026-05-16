import { test, expect, describe, afterEach } from "bun:test";
import postgres from "postgres";
import { truncateAll } from "@/tests/setup/schema";
import { getConnectionString } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { listMembershipsWithCounts, demoteMemberWithGuard } from "@/lib/data/membership";

afterEach(async () => {
  await truncateAll();
});

test("listMembershipsWithCounts paginates by (createdAt, id) cursor", async () => {
  // Seed 1 user with 6 organizations (all owner-membership)
  const base = await seedUserOrgProject("memberpage");

  const sqlc = postgres(getConnectionString(), { max: 1 });
  try {
    for (let i = 0; i < 5; i++) {
      const [o] = await sqlc<{ id: string }[]>`
        INSERT INTO neon_auth."organization" ("name", "slug", "createdAt")
        VALUES (${"Extra " + i}, ${"extra-" + i}, ${new Date(Date.now() + (i + 1) * 1000)})
        RETURNING id
      `;
      await sqlc`
        INSERT INTO neon_auth."member" ("organizationId", "userId", "role", "createdAt")
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
    const sqlc = postgres(getConnectionString(), { max: 1 });
    let secondMemberId: string;
    try {
      const [u] = await sqlc<{ id: string }[]>`
        INSERT INTO neon_auth."user" ("name", "email", "emailVerified", "updatedAt")
        VALUES ('Second', 'second-demote-ok@test.local', true, now())
        RETURNING id
      `;
      const [m] = await sqlc<{ id: string }[]>`
        INSERT INTO neon_auth."member" ("organizationId", "userId", "role", "createdAt")
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

  test("returns fail/forbidden when member belongs to a different team", async () => {
    const a = await seedUserOrgProject("demote-cross-a");
    const b = await seedUserOrgProject("demote-cross-b");

    const sqlc = postgres(getConnectionString(), { max: 1 });
    let bMemberId: string;
    try {
      const [m] = await sqlc<{ id: string }[]>`
        SELECT id FROM neon_auth."member"
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

    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") expect(outcome.code).toBe("forbidden");
    expect(demoteCalled).toBe(false);
  });

  test("last-owner guard blocks demoting the only owner", async () => {
    const f = await seedUserOrgProject("demote-lastowner");
    const sqlc = postgres(getConnectionString(), { max: 1 });
    let memberId: string;
    try {
      const [m] = await sqlc<{ id: string }[]>`
        SELECT id FROM neon_auth."member"
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
    if (outcome.kind === "fail") expect(outcome.code).toBe("cannot_leave_only_owner");
    expect(demoteCalled).toBe(false);
  });

  test("last-owner guard serializes concurrent demotes — only one of two owners gets demoted", async () => {
    const f = await seedUserOrgProject("demote-race");
    const sqlc = postgres(getConnectionString(), { max: 1 });
    let firstMemberId: string;
    let secondMemberId: string;
    try {
      const [m1] = await sqlc<{ id: string }[]>`
        SELECT id FROM neon_auth."member"
        WHERE "organizationId" = ${f.organizationId} AND "userId" = ${f.userId}
        LIMIT 1
      `;
      firstMemberId = m1.id;

      const [u] = await sqlc<{ id: string }[]>`
        INSERT INTO neon_auth."user" ("name", "email", "emailVerified", "updatedAt")
        VALUES ('Second Owner', 'second-owner-race@test.local', true, now())
        RETURNING id
      `;
      const [m2] = await sqlc<{ id: string }[]>`
        INSERT INTO neon_auth."member" ("organizationId", "userId", "role", "createdAt")
        VALUES (${f.organizationId}, ${u.id}, 'owner', now())
        RETURNING id
      `;
      secondMemberId = m2.id;
    } finally {
      await sqlc.end({ timeout: 5 });
    }

    const performDemote = async (memberId: string) => {
      const c = postgres(getConnectionString(), { max: 1 });
      try {
        await c`
          UPDATE neon_auth."member"
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
