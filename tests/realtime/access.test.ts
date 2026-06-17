import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { broker } from "@/lib/realtime/broker";
import { grantOrgAccess, revokeOrgAccess } from "@/lib/realtime/access";

beforeEach(() => {
  broker._resetForTests();
});

afterEach(async () => {
  await truncateAll();
});

const fakeConn = () => ({
  send: mock((data: string) => {
    void data;
  }),
  close: mock(() => {}),
});

/**
 * Insert an extra project into an existing org so revocation has more than
 * one subscription to clean up. Mirrors the seed helper's raw-SQL style so
 * the project lands in the same Postgres testcontainer.
 */
async function addProject(orgId: string, suffix: string): Promise<string> {
  const sql = superuserPool();
  try {
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO projects ("organization_id", "title", "identifier")
      VALUES (${orgId}, ${"Project " + suffix}, ${"PRJ" + suffix})
      RETURNING id
    `;
    return p.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("revokeOrgAccess unregisters every project sub for connected users", async () => {
  // This is the regression guard for the stale-304 / multi-tab-leak bug:
  // when membership is revoked, broker subs for the org's projects must
  // disappear so subsequent dispatches don't leak event timing on
  // resources the user no longer has access to.
  const f = await seedUserOrgProject("rev1");
  const second = await addProject(f.organizationId, "rev1b");

  const conn = fakeConn();
  broker.attach(f.userId, conn);
  broker.register(f.userId, `project:${f.projectId}`);
  broker.register(f.userId, `project:${second}`);
  broker.register(f.userId, `project-list:${f.userId}`);

  await revokeOrgAccess(f.userId, f.organizationId);

  expect([...broker.subscribers(`project:${f.projectId}`)]).toEqual([]);
  expect([...broker.subscribers(`project:${second}`)]).toEqual([]);
});

test("revokeOrgAccess dispatches project-list to the affected user", async () => {
  const f = await seedUserOrgProject("rev2");
  const conn = fakeConn();
  broker.attach(f.userId, conn);
  broker.register(f.userId, `project-list:${f.userId}`);

  await revokeOrgAccess(f.userId, f.organizationId);

  // The user must receive the project-list event so RealtimeBridge
  // invalidates `projectKeys.list()`. Without this, the side-channel
  // Last-Modified survives and `/api/projects` returns stale 304s
  // showing the now-revoked project in the home grid.
  const sent = conn.send.mock.calls.map((c) => c[0] as string);
  const projectListFrame = sent.find((f) =>
    f.includes(`"kind":"project-list"`),
  );
  expect(projectListFrame).toBeDefined();
  expect(projectListFrame).toContain(`"orgId":"${f.organizationId}"`);
});

test("revokeOrgAccess skips broker work for offline users but still emits", async () => {
  // No-throw guarantee: a disconnected user (no SSE attached) must not
  // trigger DB queries — the broker's sub map is empty for them anyway.
  // The event dispatch is still issued (it's a no-op delivery without
  // subscribers, but cheap and uniform with the connected path).
  const f = await seedUserOrgProject("rev3");

  expect(broker.hasConnections(f.userId)).toBe(false);

  await expect(
    revokeOrgAccess(f.userId, f.organizationId),
  ).resolves.toBeUndefined();
});

test("grantOrgAccess registers project subs and dispatches project-list when connected", async () => {
  const f = await seedUserOrgProject("grant1");
  const second = await addProject(f.organizationId, "grant1b");

  const conn = fakeConn();
  broker.attach(f.userId, conn);
  broker.register(f.userId, `project-list:${f.userId}`);

  await grantOrgAccess(f.userId, f.organizationId);

  expect([...broker.subscribers(`project:${f.projectId}`)]).toEqual([f.userId]);
  expect([...broker.subscribers(`project:${second}`)]).toEqual([f.userId]);

  const sent = conn.send.mock.calls.map((c) => c[0] as string);
  const projectListFrame = sent.find((f) =>
    f.includes(`"kind":"project-list"`),
  );
  expect(projectListFrame).toBeDefined();
});

test("grantOrgAccess does NOT register subs for offline users", async () => {
  // Offline users get fresh subs on their next SSE connect (the
  // `/api/events` route hydrates from `listAccessibleProjectIds`).
  // Eagerly registering here would leak entries no one is listening on.
  const f = await seedUserOrgProject("grant2");

  expect(broker.hasConnections(f.userId)).toBe(false);

  await grantOrgAccess(f.userId, f.organizationId);

  expect([...broker.subscribers(`project:${f.projectId}`)]).toEqual([]);
});

test("revokeOrgAccess swallows errors so caller mutations don't fail", async () => {
  // The org-membership hooks fire AFTER the membership row has committed.
  // A throw here would surface as a 500 to the user even though their
  // requested action (leave/remove/etc.) actually succeeded. Pass a
  // malformed orgId so the underlying query's WHERE binding rejects.
  await expect(
    revokeOrgAccess("malformed-user-id", "not-a-uuid"),
  ).resolves.toBeUndefined();
});

test("grantOrgAccess swallows errors so caller mutations don't fail", async () => {
  // Same contract as revokeOrgAccess. Force a connected user so the
  // listOrgProjectIds path runs, then pass a malformed orgId that
  // Postgres rejects at the type level.
  const userId = "00000000-0000-0000-0000-000000000abc";
  const conn = fakeConn();
  broker.attach(userId, conn);

  await expect(grantOrgAccess(userId, "not-a-uuid")).resolves.toBeUndefined();
});

test("revokeOrgAccess enumerates and unregisters subs for every project in the org after membership row is removed", async () => {
  // Regression guard: better-auth's `afterRemoveMember` hook fires AFTER the
  // membership row has been deleted. Under that timeline, a member-scoped
  // listOrgProjectIds(userId, orgId) running as app_user with the GUC set to
  // the removed user returns zero rows — the user no longer satisfies the
  // RLS predicate. revokeOrgAccess must instead route through an admin path
  // so the project enumeration still works after membership is gone.
  const f = await seedUserOrgProject("revoke-rt-no-membership");
  // Use the testcontainer superuser for DELETE on piyaz_auth.member — neither
  // app_user nor service_role have DELETE on that table; only auth_role does
  // and it has no public-schema access, so the simplest path is the same
  // superuser the seed helper uses.
  const su = superuserPool();
  let project2Id = "";
  try {
    const [p2] = await su<{ id: string }[]>`
      INSERT INTO projects ("organization_id", "title", "identifier")
      VALUES (${f.organizationId}, 'Second project', 'PRJ2')
      RETURNING id`;
    project2Id = p2.id;
    await su`DELETE FROM piyaz_auth."member"
             WHERE "userId" = ${f.userId}
               AND "organizationId" = ${f.organizationId}`;
  } finally {
    await su.end({ timeout: 5 });
  }

  const conn = fakeConn();
  broker.attach(f.userId, conn);
  broker.register(f.userId, `project:${f.projectId}`);
  broker.register(f.userId, `project:${project2Id}`);

  await revokeOrgAccess(f.userId, f.organizationId);

  expect([...broker.subscribers(`project:${f.projectId}`)]).toEqual([]);
  expect([...broker.subscribers(`project:${project2Id}`)]).toEqual([]);
});

test("revokeOrgAccess clears task:* subs in addition to project:* subs when user has connections", async () => {
  // Regression guard: PR #65's `/api/task/[id]` registers `task:<id>` subs
  // with a 10-min TTL. Without explicit cleanup on revoke, a removed user
  // who is still connected on another tab continues to receive
  // `{ kind: "task", projectId, taskId }` events for org-Y tasks they
  // previously had access to until the TTL expires — low-severity
  // information disclosure of task ids and mutation timing.
  const f = await seedUserOrgProject("rev-task");

  const conn = fakeConn();
  broker.attach(f.userId, conn);
  broker.register(f.userId, `project:${f.projectId}`);
  broker.register(f.userId, "task:t-revoked-1", 60_000);
  broker.register(f.userId, "task:t-revoked-2", 60_000);

  await revokeOrgAccess(f.userId, f.organizationId);

  expect([...broker.subscribers("task:t-revoked-1")]).toEqual([]);
  expect([...broker.subscribers("task:t-revoked-2")]).toEqual([]);
});
