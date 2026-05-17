import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import {
  appUserConnect,
  serviceRoleConnect,
  seedUserOrgProject,
} from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { expectQueryRejects } from "@/tests/setup/expect-query";

afterEach(async () => {
  await truncateAll();
});

// Tests connect as service_role (BYPASSRLS) to prove the triggers fire
// independently of RLS.
describe("immutability triggers — cross-team move prevented at DB level", () => {
  test("UPDATE projects SET organization_id = ... raises an exception", async () => {
    const a = await seedUserOrgProject("immut-a");
    const b = await seedUserOrgProject("immut-b");
    const sr = serviceRoleConnect();
    await expectQueryRejects(
      sr`UPDATE projects SET organization_id = ${b.organizationId}::uuid WHERE id = ${a.projectId}::uuid`,
      /projects\.organization_id is immutable/i,
    );
  });

  test("UPDATE projects SET title = ... still works (trigger only fires when org_id changes)", async () => {
    const fx = await seedUserOrgProject("immut-title-ok");
    const sr = serviceRoleConnect();
    try {
      await sr`UPDATE projects SET title = 'renamed' WHERE id = ${fx.projectId}::uuid`;
      const [row] = await sr<{ title: string }[]>`
        SELECT title FROM projects WHERE id = ${fx.projectId}::uuid
      `;
      expect(row.title).toBe("renamed");
    } finally {
      await sr.end({ timeout: 5 });
    }
  });

  test("UPDATE tasks SET project_id = ... raises an exception", async () => {
    const a = await seedUserOrgProject("immut-task-a");
    const b = await seedUserOrgProject("immut-task-b");
    const sr = serviceRoleConnect();
    let taskId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${a.projectId}::uuid, 'task', 1)
        RETURNING id
      `;
      taskId = t.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const sr2 = serviceRoleConnect();
    await expectQueryRejects(
      sr2`UPDATE tasks SET project_id = ${b.projectId}::uuid WHERE id = ${taskId}::uuid`,
      /tasks\.project_id is immutable/i,
    );
  });

  test("UPDATE tasks SET title = ... still works", async () => {
    const fx = await seedUserOrgProject("immut-task-title-ok");
    const sr = serviceRoleConnect();
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}::uuid, 'task', 1)
        RETURNING id
      `;
      await sr`UPDATE tasks SET title = 'renamed' WHERE id = ${t.id}::uuid`;
      const [row] = await sr<{ title: string }[]>`
        SELECT title FROM tasks WHERE id = ${t.id}::uuid
      `;
      expect(row.title).toBe("renamed");
    } finally {
      await sr.end({ timeout: 5 });
    }
  });

  test("UPDATE team_invite_code SET organization_id = ... raises an exception", async () => {
    const a = await seedUserOrgProject("immut-invite-a");
    const b = await seedUserOrgProject("immut-invite-b");
    const su = superuserPool();
    let codeId: string;
    try {
      const [row] = await su<{ id: string }[]>`
        INSERT INTO team_invite_code ("organization_id", "code", "created_by")
        VALUES (${a.organizationId}::uuid, ${"CODE-immut-invite-a"}, ${a.userId}::uuid)
        RETURNING id
      `;
      codeId = row.id;
    } finally {
      await su.end({ timeout: 5 });
    }

    const sr = serviceRoleConnect();
    await expectQueryRejects(
      sr`UPDATE team_invite_code SET organization_id = ${b.organizationId}::uuid WHERE id = ${codeId}::uuid`,
      /team_invite_code\.organization_id is immutable/i,
    );
  });
});

/**
 * A user who is a member of *both* teams A and B should not be able to
 * UPDATE a public-schema row's organization_id / project_id under app_user.
 * The RLS USING side accepts (both teams visible) but the immutability
 * trigger fires regardless. These tests pin that the trigger composes
 * correctly with RLS — without them the contract is only proven at the
 * service_role level.
 */
describe("dual-org member cannot reparent rows under app_user", () => {
  test("dual-org member: UPDATE projects.organization_id rejected", async () => {
    const a = await seedUserOrgProject("dualorg-prj-a");
    const b = await seedUserOrgProject("dualorg-prj-b");
    const su = superuserPool();
    try {
      await su`
        INSERT INTO neon_auth."member" ("organizationId", "userId", "role", "createdAt")
        VALUES (${b.organizationId}::uuid, ${a.userId}::uuid, 'member', now())
      `;
    } finally {
      await su.end({ timeout: 5 });
    }

    const c = appUserConnect();
    await expectQueryRejects(
      c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${a.userId}, true)`;
        await tx`UPDATE projects SET organization_id = ${b.organizationId}::uuid WHERE id = ${a.projectId}::uuid`;
      }) as unknown as PromiseLike<unknown>,
      /projects\.organization_id is immutable/i,
    );
  });

  test("dual-org member: UPDATE tasks.project_id rejected", async () => {
    const a = await seedUserOrgProject("dualorg-task-a");
    const b = await seedUserOrgProject("dualorg-task-b");
    const su = superuserPool();
    let taskId: string;
    try {
      await su`
        INSERT INTO neon_auth."member" ("organizationId", "userId", "role", "createdAt")
        VALUES (${b.organizationId}::uuid, ${a.userId}::uuid, 'member', now())
      `;
      const [t] = await su<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${a.projectId}::uuid, 'task', 1) RETURNING id
      `;
      taskId = t.id;
    } finally {
      await su.end({ timeout: 5 });
    }

    const c = appUserConnect();
    await expectQueryRejects(
      c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${a.userId}, true)`;
        await tx`UPDATE tasks SET project_id = ${b.projectId}::uuid WHERE id = ${taskId}::uuid`;
      }) as unknown as PromiseLike<unknown>,
      /tasks\.project_id is immutable/i,
    );
  });

  test("dual-org admin: UPDATE team_invite_code.organization_id rejected", async () => {
    const a = await seedUserOrgProject("dualorg-invite-a");
    const b = await seedUserOrgProject("dualorg-invite-b");
    const su = superuserPool();
    let codeId: string;
    try {
      await su`
        INSERT INTO neon_auth."member" ("organizationId", "userId", "role", "createdAt")
        VALUES (${b.organizationId}::uuid, ${a.userId}::uuid, 'admin', now())
      `;
      const [row] = await su<{ id: string }[]>`
        INSERT INTO team_invite_code ("organization_id", "code", "created_by")
        VALUES (${a.organizationId}::uuid, ${"CODE-dualorg-invite-a"}, ${a.userId}::uuid)
        RETURNING id
      `;
      codeId = row.id;
    } finally {
      await su.end({ timeout: 5 });
    }

    const c = appUserConnect();
    await expectQueryRejects(
      c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${a.userId}, true)`;
        await tx`UPDATE team_invite_code SET organization_id = ${b.organizationId}::uuid WHERE id = ${codeId}::uuid`;
      }) as unknown as PromiseLike<unknown>,
      /team_invite_code\.organization_id is immutable/i,
    );
  });
});

/**
 * H3: `reject_task_edges_cross_project` is SECURITY DEFINER and collapses
 * its three rejection branches into one uniform `(message, errcode)` pair.
 * Pins the contract: a cross-project endpoint (visible OR invisible to the
 * caller) and a missing endpoint must surface the same shape so the
 * trigger cannot be used as a per-row task-existence oracle.
 */
describe("H3: reject_task_edges_cross_project — uniform failure shape", () => {
  const UNIFORM_MESSAGE = /task_edges: invalid endpoint pair/;
  const UNIFORM_ERRCODE = "23514";

  async function captureInsertError(
    sourceTaskId: string,
    targetTaskId: string,
  ): Promise<{ message: string; code: string | undefined }> {
    const sr = serviceRoleConnect();
    try {
      await sr`
        INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
        VALUES (${sourceTaskId}::uuid, ${targetTaskId}::uuid, 'depends_on')
      `;
      throw new Error("expected INSERT to reject");
    } catch (err) {
      const e = err as { message: string; code?: string };
      return { message: e.message, code: e.code };
    }
  }

  test("rejects with single uniform error when target is in another project (visible)", async () => {
    const a = await seedUserOrgProject("h3-cross-a");
    const b = await seedUserOrgProject("h3-cross-b");
    const sr = serviceRoleConnect();
    let sourceTaskId: string;
    let targetTaskId: string;
    try {
      const [sourceTask] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${a.projectId}, 'src', 1) RETURNING id
      `;
      const [targetTask] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${b.projectId}, 'tgt', 1) RETURNING id
      `;
      sourceTaskId = sourceTask.id;
      targetTaskId = targetTask.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const captured = await captureInsertError(sourceTaskId, targetTaskId);
    expect(captured.message).toMatch(UNIFORM_MESSAGE);
    expect(captured.code).toBe(UNIFORM_ERRCODE);
  });

  test("rejects with same error when target task UUID does not exist", async () => {
    const fx = await seedUserOrgProject("h3-missing-target");
    const sr = serviceRoleConnect();
    let sourceTaskId: string;
    try {
      const [sourceTask] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'src', 1) RETURNING id
      `;
      sourceTaskId = sourceTask.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const bogusTargetId = "00000000-0000-0000-0000-000000000000";
    const captured = await captureInsertError(sourceTaskId, bogusTargetId);
    expect(captured.message).toMatch(UNIFORM_MESSAGE);
    expect(captured.code).toBe(UNIFORM_ERRCODE);
  });

  test("rejects with same error when source task UUID does not exist", async () => {
    const fx = await seedUserOrgProject("h3-missing-source");
    const sr = serviceRoleConnect();
    let targetTaskId: string;
    try {
      const [targetTask] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'tgt', 1) RETURNING id
      `;
      targetTaskId = targetTask.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const bogusSourceId = "00000000-0000-0000-0000-000000000000";
    const captured = await captureInsertError(bogusSourceId, targetTaskId);
    expect(captured.message).toMatch(UNIFORM_MESSAGE);
    expect(captured.code).toBe(UNIFORM_ERRCODE);
  });

  test("allows same-project edge insertion (positive control)", async () => {
    const fx = await seedUserOrgProject("h3-same-project");
    const sr = serviceRoleConnect();
    try {
      const [s] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'src', 1) RETURNING id
      `;
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'tgt', 2) RETURNING id
      `;
      const rows = await sr<{ id: string }[]>`
        INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
        VALUES (${s.id}, ${t.id}, 'depends_on')
        RETURNING id
      `;
      expect(rows.length).toBe(1);
    } finally {
      await sr.end({ timeout: 5 });
      const su = superuserPool();
      try {
        await su`DELETE FROM task_edges WHERE TRUE`;
      } finally {
        await su.end({ timeout: 5 });
      }
    }
  });
});
