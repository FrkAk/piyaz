import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import {
  appUserConnect,
  seedUserOrgProject,
  serviceRoleConnect,
} from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { expectQueryRejects } from "@/tests/setup/expect-query";

afterEach(async () => {
  await truncateAll();
});

/** A second user added to an existing org as a plain member. */
async function seedSecondMember(
  organizationId: string,
  suffix: string,
): Promise<string> {
  const sql = superuserPool();
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
    VALUES (${"User " + suffix}, ${"user" + suffix + "@test.local"}, true, now())
    RETURNING id
  `;
  await sql`
    INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
    VALUES (${organizationId}, ${u.id}, 'member', now())
  `;
  return u.id;
}

/** Add an existing user to a second org as a plain member (dual-org). */
async function addMembership(
  organizationId: string,
  userId: string,
): Promise<void> {
  const sql = superuserPool();
  await sql`
    INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
    VALUES (${organizationId}, ${userId}, 'member', now())
  `;
}

/**
 * RLS coverage for the Notes tables (PYZ-248). Connects as `app_user`
 * (NOBYPASSRLS) so the policies actually fire, mirroring tests/data/rls.test.ts.
 *
 * Invariants exercised:
 *   AC2 — a private note is visible only to its author; a team note is visible
 *         to every project member.
 *   AC3 — a cross-org note id returns zero rows (2-hop projects subquery).
 *   AC4 — notes_search_idx (gin), notes_tags_idx (gin) and the partial
 *         notes_feed_idx exist after the schema is applied.
 *   AC5 — deleting a note cascades note_task_links / note_links / note_revisions;
 *         deleting a task cascades its note_task_links.
 *   Hardening — cross-project link inserts raise 23514; the partial slug unique
 *         lets a new note reuse a trashed note's slug.
 */
describe("Notes RLS — visibility, isolation, cascade, hardening", () => {
  test("AC2: private note is author-only; team note is visible to every member", async () => {
    const fx = await seedUserOrgProject("notes-vis");
    const userB = await seedSecondMember(fx.organizationId, "notes-vis-b");

    const su = superuserPool();
    const [priv] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${fx.projectId}, 'Private', 'private', 'private', ${fx.userId})
      RETURNING id
    `;
    const [team] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${fx.projectId}, 'Team', 'team', 'team', ${fx.userId})
      RETURNING id
    `;

    const c = appUserConnect();
    // Author A sees both.
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM notes WHERE id IN (${priv.id}, ${team.id})
      `;
      expect(rows.map((r) => r.id).sort()).toEqual([priv.id, team.id].sort());
    });
    // Member B sees only the team note.
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${userB}, true)`;
      const privRows = await tx<{ id: string }[]>`
        SELECT id FROM notes WHERE id = ${priv.id}
      `;
      expect(privRows.length).toBe(0);
      const teamRows = await tx<{ id: string }[]>`
        SELECT id FROM notes WHERE id = ${team.id}
      `;
      expect(teamRows.length).toBe(1);
    });
  });

  test("AC3: a cross-org note id returns zero rows under app_user", async () => {
    const teamA = await seedUserOrgProject("notes-x-a");
    const teamB = await seedUserOrgProject("notes-x-b");

    const su = superuserPool();
    const [note] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${teamA.projectId}, 'A', 'a', 'team', ${teamA.userId})
      RETURNING id
    `;

    const c = appUserConnect();
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${teamB.userId}, true)`;
      const leaked = await tx<{ id: string }[]>`
        SELECT id FROM notes WHERE id = ${note.id}
      `;
      expect(leaked.length).toBe(0);
    });
  });

  test("AC4: GIN search/tags indexes and the partial feed index exist", async () => {
    const sql = superuserPool();
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'notes'
        AND indexname IN ('notes_search_idx', 'notes_tags_idx', 'notes_feed_idx')
    `;
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.notes_search_idx).toMatch(/USING gin/i);
    expect(byName.notes_tags_idx).toMatch(/USING gin/i);
    expect(byName.notes_feed_idx).toMatch(/feed_mode <> 'none'/);
  });

  test("AC5: deleting a note cascades its task links, note links, and revisions", async () => {
    const fx = await seedUserOrgProject("notes-cascade");
    const su = superuserPool();
    const [note] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, created_by)
      VALUES (${fx.projectId}, 'N', 'n', ${fx.userId}) RETURNING id
    `;
    const [other] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, created_by)
      VALUES (${fx.projectId}, 'O', 'o', ${fx.userId}) RETURNING id
    `;
    const [task] = await su<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number)
      VALUES (${fx.projectId}, 'T', 1) RETURNING id
    `;
    await su`INSERT INTO note_task_links (note_id, task_id) VALUES (${note.id}, ${task.id})`;
    await su`INSERT INTO note_links (source_note_id, target_note_id) VALUES (${note.id}, ${other.id})`;
    await su`INSERT INTO note_revisions (note_id, version, title, body) VALUES (${note.id}, 1, 'N', 'b')`;

    await su`DELETE FROM notes WHERE id = ${note.id}`;

    const [{ ntl }] = await su<{ ntl: number }[]>`
      SELECT count(*)::int AS ntl FROM note_task_links WHERE note_id = ${note.id}
    `;
    const [{ nl }] = await su<{ nl: number }[]>`
      SELECT count(*)::int AS nl FROM note_links WHERE source_note_id = ${note.id}
    `;
    const [{ nr }] = await su<{ nr: number }[]>`
      SELECT count(*)::int AS nr FROM note_revisions WHERE note_id = ${note.id}
    `;
    expect(ntl).toBe(0);
    expect(nl).toBe(0);
    expect(nr).toBe(0);
  });

  test("AC5: deleting a referenced task cascades its note_task_links rows", async () => {
    const fx = await seedUserOrgProject("notes-task-cascade");
    const su = superuserPool();
    const [note] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, created_by)
      VALUES (${fx.projectId}, 'N', 'n', ${fx.userId}) RETURNING id
    `;
    const [task] = await su<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number)
      VALUES (${fx.projectId}, 'T', 1) RETURNING id
    `;
    await su`INSERT INTO note_task_links (note_id, task_id) VALUES (${note.id}, ${task.id})`;

    await su`DELETE FROM tasks WHERE id = ${task.id}`;

    const [{ ntl }] = await su<{ ntl: number }[]>`
      SELECT count(*)::int AS ntl FROM note_task_links WHERE task_id = ${task.id}
    `;
    expect(ntl).toBe(0);
    // The note itself survives the task delete.
    const [{ n }] = await su<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notes WHERE id = ${note.id}
    `;
    expect(n).toBe(1);
  });

  test("note_links trigger rejects a cross-project pair under app_user (23514)", async () => {
    const teamA = await seedUserOrgProject("notes-nl-trig-a");
    const teamB = await seedUserOrgProject("notes-nl-trig-b");
    await addMembership(teamB.organizationId, teamA.userId);

    const su = superuserPool();
    const [a] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${teamA.projectId}, 'A', 'a', 'team', ${teamA.userId}) RETURNING id
    `;
    const [b] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${teamB.projectId}, 'B', 'b', 'team', ${teamA.userId}) RETURNING id
    `;

    const c = appUserConnect();
    await expectQueryRejects(
      c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamA.userId}, true)`;
        await tx`
          INSERT INTO note_links (source_note_id, target_note_id)
          VALUES (${a.id}, ${b.id})
        `;
      }),
      /invalid endpoint pair|note_links|row-level security/i,
    );
  });

  test("note_task_links trigger rejects a cross-project note/task pair (23514)", async () => {
    const teamA = await seedUserOrgProject("notes-ntl-trig-a");
    const teamB = await seedUserOrgProject("notes-ntl-trig-b");
    await addMembership(teamB.organizationId, teamA.userId);

    const su = superuserPool();
    const [note] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${teamA.projectId}, 'A', 'a', 'team', ${teamA.userId}) RETURNING id
    `;
    const [task] = await su<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number)
      VALUES (${teamB.projectId}, 'B-task', 1) RETURNING id
    `;

    const c = appUserConnect();
    await expectQueryRejects(
      c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamA.userId}, true)`;
        await tx`
          INSERT INTO note_task_links (note_id, task_id)
          VALUES (${note.id}, ${task.id})
        `;
      }),
      /invalid note\/task pair|note_task_links|row-level security/i,
    );
  });

  test("notes.project_id is immutable — cross-project move is rejected", async () => {
    const teamA = await seedUserOrgProject("notes-imm-a");
    const teamB = await seedUserOrgProject("notes-imm-b");
    await addMembership(teamB.organizationId, teamA.userId);

    const su = superuserPool();
    const [note] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${teamA.projectId}, 'A', 'a', 'team', ${teamA.userId}) RETURNING id
    `;

    const c = appUserConnect();
    await expectQueryRejects(
      c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamA.userId}, true)`;
        await tx`
          UPDATE notes SET project_id = ${teamB.projectId} WHERE id = ${note.id}
        `;
      }),
      /project_id is immutable|notes\.project_id/i,
    );
  });

  test("partial slug unique lets a new note reuse a trashed note's slug", async () => {
    const fx = await seedUserOrgProject("notes-slug-reuse");
    const su = superuserPool();
    const [first] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, created_by)
      VALUES (${fx.projectId}, 'First', 'shared-slug', ${fx.userId}) RETURNING id
    `;
    // Soft-delete frees the slug namespace.
    await su`UPDATE notes SET deleted_at = now() WHERE id = ${first.id}`;
    const reuse = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, created_by)
      VALUES (${fx.projectId}, 'Second', 'shared-slug', ${fx.userId}) RETURNING id
    `;
    expect(reuse.length).toBe(1);

    // Two live notes with the same slug still collide.
    await expectQueryRejects(
      su`
        INSERT INTO notes (project_id, title, slug, created_by)
        VALUES (${fx.projectId}, 'Third', 'shared-slug', ${fx.userId})
      ` as unknown as PromiseLike<unknown>,
      /duplicate key value|notes_project_slug_unique/i,
    );
  });

  test("service_role (BYPASSRLS) sees notes regardless of GUC state", async () => {
    const fx = await seedUserOrgProject("notes-sr");
    const su = superuserPool();
    const [note] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${fx.projectId}, 'A', 'a', 'private', ${fx.userId}) RETURNING id
    `;
    const c = serviceRoleConnect();
    const rows = await c<{ id: string }[]>`SELECT id FROM notes WHERE id = ${note.id}`;
    expect(rows.length).toBe(1);
  });
});
