import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import {
  appUserConnect,
  seedUserOrgProject,
  serviceRoleConnect,
} from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { InvalidUserIdError, withUserContext } from "@/lib/db/rls";
import { expectQueryRejects } from "@/tests/setup/expect-query";

afterEach(async () => {
  await truncateAll();
});

/**
 * Defense-in-depth RLS coverage. These tests connect as `app_user` (no
 * BYPASSRLS) — provisioned by `tests/setup/migrate.ts:provisionRoles` —
 * rather than the testcontainer superuser used by `seedUserOrgProject`,
 * because RLS policies are silently bypassed for BYPASSRLS roles.
 *
 * Invariants exercised:
 *   1. Default-deny when `app.user_id` is unset.
 *   2. Same-team userId returns the row (happy path).
 *   3. Cross-team userId returns zero rows (no leak).
 *   4. `withUserContext` rejects empty userId at the helper boundary.
 *   5. 2-hop policy (tasks) catches cross-team reads.
 *   6. 3-hop policy (task_assignees) catches cross-team reads.
 *   7. serviceRoleDb sees rows regardless of GUC state (BYPASSRLS).
 *   8. INSERT without GUC fails the policy `WITH CHECK` clause.
 *   9. INSERT with the correct GUC writes successfully.
 */
describe("RLS — defense-in-depth on team isolation", () => {
  test("app_user sees zero rows when app.user_id is unset (default-deny)", async () => {
    await seedUserOrgProject("rls-a");
    const c = appUserConnect();
    try {
      const rows = await c<{ id: string }[]>`SELECT id FROM projects`;
      expect(rows.length).toBe(0);
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("app_user with set_config to its own user sees its team's project", async () => {
    const fx = await seedUserOrgProject("rls-b");
    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
        const found =
          await tx<{ id: string }[]>`SELECT id FROM projects WHERE id = ${fx.projectId}`;
        expect(found.length).toBe(1);
        expect(found[0].id).toBe(fx.projectId);
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("app_user with another team's userId sees zero rows (no cross-team leak)", async () => {
    const teamA = await seedUserOrgProject("rls-c");
    const teamB = await seedUserOrgProject("rls-d");

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamB.userId}, true)`;
        const leaked =
          await tx<{ id: string }[]>`SELECT id FROM projects WHERE id = ${teamA.projectId}`;
        expect(leaked.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("withUserContext rejects empty userId at the helper boundary", async () => {
    await expect(withUserContext("", async () => 1)).rejects.toThrow(
      InvalidUserIdError,
    );
  });

  test("RLS policy covers tasks (2-hop) — cross-team userId sees zero rows", async () => {
    const teamA = await seedUserOrgProject("rls-e");
    const teamB = await seedUserOrgProject("rls-f");

    const superuser = superuserPool();
    try {
      await superuser`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${teamA.projectId}, 'A-task', 1)
      `;
    } finally {
      await superuser.end({ timeout: 5 });
    }

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamB.userId}, true)`;
        const leaked =
          await tx<{ id: string }[]>`SELECT id FROM tasks WHERE project_id = ${teamA.projectId}`;
        expect(leaked.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("RLS policy covers task_assignees (3-hop) — cross-team userId sees zero rows", async () => {
    const teamA = await seedUserOrgProject("rls-g");
    const teamB = await seedUserOrgProject("rls-h");

    const superuser = superuserPool();
    let taskAId = "";
    try {
      const [{ id }] = await superuser<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${teamA.projectId}, 'A-task', 1)
        RETURNING id
      `;
      taskAId = id;
      await superuser`
        INSERT INTO task_assignees (task_id, user_id) VALUES (${taskAId}, ${teamA.userId})
      `;
    } finally {
      await superuser.end({ timeout: 5 });
    }

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamB.userId}, true)`;
        const leaked = await tx<
          { task_id: string }[]
        >`SELECT task_id FROM task_assignees WHERE task_id = ${taskAId}`;
        expect(leaked.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("service_role (BYPASSRLS) sees rows regardless of GUC state", async () => {
    const fx = await seedUserOrgProject("rls-i");
    const c = serviceRoleConnect();
    try {
      const rows =
        await c<{ id: string }[]>`SELECT id FROM projects WHERE id = ${fx.projectId}`;
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(fx.projectId);
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("INSERT into projects without set_config fails the WITH CHECK clause", async () => {
    const fx = await seedUserOrgProject("rls-j");
    const c = appUserConnect();
    try {
      let threw = false;
      let inserted: { id: string }[] | undefined;
      try {
        inserted = await c<{ id: string }[]>`
          INSERT INTO projects (organization_id, title, identifier)
          VALUES (${fx.organizationId}, 'leak', 'LEAK')
          RETURNING id
        `;
      } catch (e) {
        threw = true;
        expect(String(e)).toMatch(/row-level security/i);
      }
      if (!threw) {
        expect(inserted?.length ?? 0).toBe(0);
      }
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("INSERT into projects with set_config to the org's member succeeds", async () => {
    const fx = await seedUserOrgProject("rls-k");
    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO projects (organization_id, title, identifier)
          VALUES (${fx.organizationId}, 'ok', 'OK')
          RETURNING id
        `;
        expect(typeof row.id).toBe("string");
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("task_edges WITH CHECK rejects INSERT with target in another team", async () => {
    const fxA = await seedUserOrgProject("rls-cross-target-a");
    const fxB = await seedUserOrgProject("rls-cross-target-b");

    const sr = serviceRoleConnect();
    let taskAId: string;
    let taskBId: string;
    try {
      const [a] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fxA.projectId}, 'task-A', 1)
        RETURNING id
      `;
      const [b] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fxB.projectId}, 'task-B', 1)
        RETURNING id
      `;
      taskAId = a.id;
      taskBId = b.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const c = appUserConnect();
    await expectQueryRejects(
      c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${fxA.userId}, true)`;
        await tx`
          INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
          VALUES (${taskAId}, ${taskBId}, 'depends_on')
        `;
      }),
      /row-level security|violates row-level security/i,
    );
  });

  test("task_edges USING hides cross-team edges from source-side member — SELECT and DELETE are both blocked", async () => {
    const fxA = await seedUserOrgProject("rls-edge-del-a");
    const fxB = await seedUserOrgProject("rls-edge-del-b");

    const sr = serviceRoleConnect();
    let taskAId: string;
    let taskBId: string;
    try {
      const [a] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fxA.projectId}, 'task-A', 1)
        RETURNING id
      `;
      const [b] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fxB.projectId}, 'task-B', 1)
        RETURNING id
      `;
      taskAId = a.id;
      taskBId = b.id;
      await sr`
        INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
        VALUES (${taskAId}, ${taskBId}, 'depends_on')
      `;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${fxA.userId}, true)`;
        const visible = await tx<{ source_task_id: string; target_task_id: string }[]>`
          SELECT source_task_id, target_task_id FROM task_edges
          WHERE source_task_id = ${taskAId}
        `;
        expect(visible.length).toBe(0);
        await tx`DELETE FROM task_edges WHERE source_task_id = ${taskAId}`;
      });
    } finally {
      await c.end({ timeout: 5 });
    }

    const sr2 = serviceRoleConnect();
    try {
      const [row] = await sr2<{ count: number }[]>`
        SELECT count(*)::int AS count FROM task_edges
        WHERE source_task_id = ${taskAId} AND target_task_id = ${taskBId}
      `;
      expect(row.count).toBe(1);
    } finally {
      await sr2.end({ timeout: 5 });
    }
  });

  test("cross-team UPDATE on projects mutates zero rows under app_user", async () => {
    const teamA = await seedUserOrgProject("rls-x-upd-prj-a");
    const teamB = await seedUserOrgProject("rls-x-upd-prj-b");

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamB.userId}, true)`;
        const updated = await tx<{ id: string }[]>`
          UPDATE projects SET title = 'pwned' WHERE id = ${teamA.projectId}
          RETURNING id
        `;
        expect(updated.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }

    const su = superuserPool();
    const [verify] = await su<{ title: string }[]>`
      SELECT title FROM projects WHERE id = ${teamA.projectId}
    `;
    expect(verify.title).not.toBe("pwned");
  });

  test("cross-team DELETE on projects affects zero rows under app_user", async () => {
    const teamA = await seedUserOrgProject("rls-x-del-prj-a");
    const teamB = await seedUserOrgProject("rls-x-del-prj-b");

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamB.userId}, true)`;
        const deleted = await tx<{ id: string }[]>`
          DELETE FROM projects WHERE id = ${teamA.projectId} RETURNING id
        `;
        expect(deleted.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }

    const su = superuserPool();
    const [verify] = await su<{ id: string }[]>`
      SELECT id FROM projects WHERE id = ${teamA.projectId}
    `;
    expect(verify.id).toBe(teamA.projectId);
  });

  test("cross-team UPDATE on tasks mutates zero rows under app_user", async () => {
    const teamA = await seedUserOrgProject("rls-x-upd-task-a");
    const teamB = await seedUserOrgProject("rls-x-upd-task-b");

    const su = superuserPool();
    const [taskA] = await su<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, status)
      VALUES (${teamA.projectId}, 'A task', 1, 'planned')
      RETURNING id
    `;

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamB.userId}, true)`;
        const updated = await tx<{ id: string }[]>`
          UPDATE tasks SET title = 'pwned' WHERE id = ${taskA.id} RETURNING id
        `;
        expect(updated.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }

    const [verify] = await su<{ title: string }[]>`
      SELECT title FROM tasks WHERE id = ${taskA.id}
    `;
    expect(verify.title).not.toBe("pwned");
  });

  test("cross-team DELETE on tasks affects zero rows under app_user", async () => {
    const teamA = await seedUserOrgProject("rls-x-del-task-a");
    const teamB = await seedUserOrgProject("rls-x-del-task-b");

    const su = superuserPool();
    const [taskA] = await su<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, status)
      VALUES (${teamA.projectId}, 'A task', 2, 'planned')
      RETURNING id
    `;

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamB.userId}, true)`;
        const deleted = await tx<{ id: string }[]>`
          DELETE FROM tasks WHERE id = ${taskA.id} RETURNING id
        `;
        expect(deleted.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }

    const [verify] = await su<{ id: string }[]>`
      SELECT id FROM tasks WHERE id = ${taskA.id}
    `;
    expect(verify.id).toBe(taskA.id);
  });

  test("cross-team SELECT on task_acceptance_criteria returns zero rows", async () => {
    const teamA = await seedUserOrgProject("rls-x-ac-a");
    const teamB = await seedUserOrgProject("rls-x-ac-b");

    const su = superuserPool();
    const [task] = await su<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, status)
      VALUES (${teamA.projectId}, 'A', 3, 'planned')
      RETURNING id
    `;
    const [criterion] = await su<{ id: string }[]>`
      INSERT INTO task_acceptance_criteria (id, task_id, position, text)
      VALUES (gen_random_uuid(), ${task.id}, 0, 'A criterion')
      RETURNING id
    `;

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamB.userId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM task_acceptance_criteria WHERE id = ${criterion.id}
        `;
        expect(rows.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("cross-team SELECT on task_decisions returns zero rows", async () => {
    const teamA = await seedUserOrgProject("rls-x-td-a");
    const teamB = await seedUserOrgProject("rls-x-td-b");

    const su = superuserPool();
    const [task] = await su<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, status)
      VALUES (${teamA.projectId}, 'A', 4, 'planned')
      RETURNING id
    `;
    const [dec] = await su<{ id: string }[]>`
      INSERT INTO task_decisions (id, task_id, position, text, source, decision_date)
      VALUES (gen_random_uuid(), ${task.id}, 0, 'A decision', 'inferred', '2026-05-16')
      RETURNING id
    `;

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamB.userId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM task_decisions WHERE id = ${dec.id}
        `;
        expect(rows.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("cross-team SELECT on task_links returns zero rows", async () => {
    const teamA = await seedUserOrgProject("rls-x-tl-a");
    const teamB = await seedUserOrgProject("rls-x-tl-b");

    const su = superuserPool();
    const [task] = await su<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, status)
      VALUES (${teamA.projectId}, 'A', 5, 'planned')
      RETURNING id
    `;
    const [link] = await su<{ id: string }[]>`
      INSERT INTO task_links (task_id, url, kind)
      VALUES (${task.id}, 'https://example.test/x', 'other')
      RETURNING id
    `;

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamB.userId}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM task_links WHERE id = ${link.id}
        `;
        expect(rows.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("team_invite_code RESTRICTIVE write floor blocks regular-member INSERT", async () => {
    // Pin H1 directly at the SQL layer: even if a future permissive
    // policy is added that would allow a member to INSERT, the
    // RESTRICTIVE per-command floor still requires admin/owner.
    const teamA = await seedUserOrgProject("rls-x-tic-floor-admin");
    const su = superuserPool();
    const [u] = await su<{ id: string }[]>`
      INSERT INTO neon_auth."user" ("name", "email", "emailVerified", "updatedAt")
      VALUES ('Regular Member', 'regular@test.local', true, now())
      RETURNING id
    `;
    await su`
      INSERT INTO neon_auth."member" ("organizationId", "userId", "role", "createdAt")
      VALUES (${teamA.organizationId}, ${u.id}, 'member', now())
    `;

    const c = appUserConnect();
    try {
      await expectQueryRejects(
        c.begin(async (tx) => {
          await tx`SELECT set_config('app.user_id', ${u.id}, true)`;
          await tx`
            INSERT INTO team_invite_code (organization_id, code, created_by)
            VALUES (${teamA.organizationId}, 'MEMBER-BLOCKED', ${u.id})
          `;
        }),
        /violates row-level security policy|new row violates row-level/,
      );
    } finally {
      await c.end({ timeout: 5 });
    }
  });
});
