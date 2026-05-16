import { afterEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { truncateAll } from "@/tests/setup/schema";
import {
  appUserConnect,
  seedUserOrgProject,
  serviceRoleConnect,
} from "@/tests/setup/seed";
import { getConnectionString } from "@/tests/setup/global";
import { withUserContext } from "@/lib/db/rls";

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
      TypeError,
    );
  });

  test("RLS policy covers tasks (2-hop) — cross-team userId sees zero rows", async () => {
    const teamA = await seedUserOrgProject("rls-e");
    const teamB = await seedUserOrgProject("rls-f");

    const superuser = postgres(getConnectionString(), { max: 1 });
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

    const superuser = postgres(getConnectionString(), { max: 1 });
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
    try {
      await expect(
        c.begin(async (tx) => {
          await tx`SELECT set_config('app.user_id', ${fxA.userId}, true)`;
          await tx`
            INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
            VALUES (${taskAId}, ${taskBId}, 'depends_on')
          `;
        }),
      ).rejects.toThrow(/row-level security|violates row-level security/i);
    } finally {
      await c.end({ timeout: 5 });
    }
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
});
