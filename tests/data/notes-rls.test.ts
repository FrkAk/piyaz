import { afterEach, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { truncateAll } from "@/tests/setup/schema";
import {
  appUserConnect,
  seedUserOrgProject,
  serviceRoleConnect,
} from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { expectQueryRejects } from "@/tests/setup/expect-query";

type Tx = postgres.TransactionSql;

afterEach(async () => {
  await truncateAll();
});

/**
 * Run `work` as `app_user` with `app.user_id` set to `userId`, and capture the
 * rejection's `{ message, code }`. The SQLSTATE (`code`) is what distinguishes
 * a trigger rejection (23514) from an RLS WITH CHECK rejection (42501), so
 * tests assert the code, not just a message substring.
 *
 * @param userId - Value for the `app.user_id` GUC.
 * @param work - Statements to run inside the RLS-scoped transaction.
 * @returns The caught error's message and SQLSTATE code.
 * @throws Error when `work` resolves instead of rejecting.
 */
async function captureAppUserError(
  userId: string,
  work: (tx: Tx) => Promise<unknown>,
): Promise<{ message: string; code: string | undefined }> {
  const c = appUserConnect();
  try {
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await work(tx);
    });
  } catch (err) {
    const e = err as { message: string; code?: string };
    return { message: e.message, code: e.code };
  }
  throw new Error("expected the statement to reject, but it succeeded");
}

/**
 * Insert a new user and add them to an existing org as a plain member.
 *
 * @param organizationId - Org the new member joins.
 * @param suffix - Unique suffix for the user's name and email.
 * @returns The new user's id.
 */
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

/**
 * Add an existing user to another org as a plain member (dual-org setup).
 *
 * @param organizationId - Org to add the membership to.
 * @param userId - Existing user to grant membership.
 */
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
 * RLS coverage for the Notes tables. Connects as `app_user`
 * (NOBYPASSRLS) so the policies actually fire, mirroring tests/data/rls.test.ts.
 *
 * Invariants exercised:
 *   AC2 — a private note is visible only to its author; a team note is visible
 *         to every project member.
 *   AC3 — a cross-org note id returns zero rows (2-hop projects subquery).
 *   AC4 — notes_search_idx (gin), notes_tags_idx (gin) and the partial
 *         notes_feed_idx exist after the schema is applied.
 *   AC5 — deleting a note cascades note_task_links / note_links / note_revisions
 *         (both link directions); deleting a task cascades its note_task_links.
 *   Hardening — cross-project link inserts raise 23514 (trigger, asserted by
 *         SQLSTATE, not RLS's 42501); a member cannot privatize-and-steal a
 *         team note (created_by immutable, 42501); note_revisions is
 *         UPDATE-revoked from app_user; the partial slug unique lets a new note
 *         reuse a trashed note's slug.
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
    const byName = Object.fromEntries(
      rows.map((r) => [r.indexname, r.indexdef]),
    );
    expect(byName.notes_search_idx).toMatch(/USING gin/i);
    // The search index must cover the generated tsvector, not some other column.
    expect(byName.notes_search_idx).toMatch(/search_tsv/);
    expect(byName.notes_tags_idx).toMatch(/USING gin/i);
    expect(byName.notes_feed_idx).toMatch(/feed_mode <> 'none'/);
  });

  test("AC4: search_tsv is a STORED generated tsvector column", async () => {
    const sql = superuserPool();
    const [col] = await sql<{ attgenerated: string; type: string }[]>`
      SELECT attgenerated, format_type(atttypid, atttypmod) AS type
      FROM pg_attribute
      WHERE attrelid = 'public.notes'::regclass
        AND attname = 'search_tsv'
        AND NOT attisdropped
    `;
    // 's' = STORED generated; '' = a plain column (generation silently dropped).
    expect(col.attgenerated).toBe("s");
    expect(col.type).toBe("tsvector");
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
    // Both directions: note as link source AND as link target, so the delete
    // must cascade through both FKs.
    await su`INSERT INTO note_links (source_note_id, target_note_id) VALUES (${note.id}, ${other.id})`;
    await su`INSERT INTO note_links (source_note_id, target_note_id) VALUES (${other.id}, ${note.id})`;
    await su`INSERT INTO note_revisions (note_id, version, title, body) VALUES (${note.id}, 1, 'N', 'b')`;

    await su`DELETE FROM notes WHERE id = ${note.id}`;

    const [{ ntl }] = await su<{ ntl: number }[]>`
      SELECT count(*)::int AS ntl FROM note_task_links WHERE note_id = ${note.id}
    `;
    const [{ nl }] = await su<{ nl: number }[]>`
      SELECT count(*)::int AS nl FROM note_links
      WHERE source_note_id = ${note.id} OR target_note_id = ${note.id}
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

  test("note_links trigger rejects a cross-project pair under app_user (23514, not RLS)", async () => {
    const teamA = await seedUserOrgProject("notes-nl-trig-a");
    const teamB = await seedUserOrgProject("notes-nl-trig-b");
    // teamA's user joins teamB so BOTH endpoints are RLS-visible: an RLS
    // rejection (42501) is impossible here, so a 23514 proves the trigger
    // fired rather than the WITH CHECK floor.
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

    const captured = await captureAppUserError(
      teamA.userId,
      (tx) =>
        tx`
        INSERT INTO note_links (source_note_id, target_note_id)
        VALUES (${a.id}, ${b.id})
      `,
    );
    expect(captured.code).toBe("23514");
    expect(captured.message).toMatch(/note_links: invalid endpoint pair/);
  });

  test("note_task_links trigger rejects a cross-project note/task pair (23514, not RLS)", async () => {
    const teamA = await seedUserOrgProject("notes-ntl-trig-a");
    const teamB = await seedUserOrgProject("notes-ntl-trig-b");
    // Dual-org membership keeps both the note and the task RLS-visible, so a
    // 23514 proves the trigger fired and not the new task_id WITH CHECK floor.
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

    const captured = await captureAppUserError(
      teamA.userId,
      (tx) =>
        tx`
        INSERT INTO note_task_links (note_id, task_id)
        VALUES (${note.id}, ${task.id})
      `,
    );
    expect(captured.code).toBe("23514");
    expect(captured.message).toMatch(
      /note_task_links: invalid note\/task pair/,
    );
  });

  test("note_links: app_user inserts a same-project pair (RLS + trigger allow the write)", async () => {
    const fx = await seedUserOrgProject("notes-nl-ok");
    const su = superuserPool();
    const [a] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${fx.projectId}, 'A', 'a', 'team', ${fx.userId}) RETURNING id
    `;
    const [b] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${fx.projectId}, 'B', 'b', 'team', ${fx.userId}) RETURNING id
    `;

    const c = appUserConnect();
    const rows = await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
      return tx<{ id: string }[]>`
        INSERT INTO note_links (source_note_id, target_note_id)
        VALUES (${a.id}, ${b.id})
        RETURNING id
      `;
    });
    expect(rows.length).toBe(1);
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

  test("notes.created_by is immutable — a member cannot privatize-and-steal a team note", async () => {
    const fx = await seedUserOrgProject("notes-steal");
    const userB = await seedSecondMember(fx.organizationId, "notes-steal-b");

    const su = superuserPool();
    const [team] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${fx.projectId}, 'Team', 'team', 'team', ${fx.userId})
      RETURNING id
    `;

    // Member B tries to flip A's team note to private and reassign ownership.
    // The created_by trigger rejects (42501) before WITH CHECK is reached.
    const captured = await captureAppUserError(
      userB,
      (tx) =>
        tx`
        UPDATE notes SET visibility = 'private', created_by = ${userB}
        WHERE id = ${team.id}
      `,
    );
    expect(captured.code).toBe("42501");
    expect(captured.message).toMatch(/created_by is immutable/);

    // The note is untouched: still team-visible and owned by A.
    const [row] = await su<{ visibility: string; created_by: string }[]>`
      SELECT visibility, created_by FROM notes WHERE id = ${team.id}
    `;
    expect(row.visibility).toBe("team");
    expect(row.created_by).toBe(fx.userId);

    // The author may still legitimately un-share their own note (created_by
    // unchanged, so the trigger stays silent and WITH CHECK passes).
    const c = appUserConnect();
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
      await tx`UPDATE notes SET visibility = 'private' WHERE id = ${team.id}`;
    });
    const [after] = await su<{ visibility: string }[]>`
      SELECT visibility FROM notes WHERE id = ${team.id}
    `;
    expect(after.visibility).toBe("private");
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
      (async () => {
        await su`
          INSERT INTO notes (project_id, title, slug, created_by)
          VALUES (${fx.projectId}, 'Third', 'shared-slug', ${fx.userId})
        `;
      })(),
      /duplicate key value|notes_project_slug_unique/i,
    );
  });

  test("service_role (BYPASSRLS) sees a private note even under a non-member GUC", async () => {
    const fx = await seedUserOrgProject("notes-sr");
    const outsider = await seedUserOrgProject("notes-sr-out");
    const su = superuserPool();
    const [note] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${fx.projectId}, 'A', 'a', 'private', ${fx.userId}) RETURNING id
    `;
    // Set the GUC to a non-member: an app_user would see zero rows here, so a
    // hit proves BYPASSRLS overrides the policy rather than the GUC matching.
    const c = serviceRoleConnect();
    const rows = await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${outsider.userId}, true)`;
      return tx<{ id: string }[]>`SELECT id FROM notes WHERE id = ${note.id}`;
    });
    expect(rows.length).toBe(1);
  });

  test("note_revisions is append-only: app_user may not UPDATE a revision", async () => {
    const fx = await seedUserOrgProject("notes-rev-ro");
    const su = superuserPool();
    const [note] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${fx.projectId}, 'N', 'n', 'team', ${fx.userId}) RETURNING id
    `;
    await su`
      INSERT INTO note_revisions (note_id, version, title, body, created_by)
      VALUES (${note.id}, 1, 'N', 'b', ${fx.userId})
    `;

    // app_user lacks the UPDATE grant on note_revisions (docker/grants.sql).
    const captured = await captureAppUserError(
      fx.userId,
      (tx) =>
        tx`UPDATE note_revisions SET body = 'tampered' WHERE note_id = ${note.id}`,
    );
    expect(captured.code).toBe("42501");
    expect(captured.message).toMatch(/permission denied/i);
  });

  test("note_revisions INSERT cannot forge created_by — only caller or NULL is accepted", async () => {
    const fx = await seedUserOrgProject("notes-rev-forge");
    const userB = await seedSecondMember(
      fx.organizationId,
      "notes-rev-forge-b",
    );
    const su = superuserPool();
    const [note] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${fx.projectId}, 'Team', 'team', 'team', ${fx.userId}) RETURNING id
    `;

    // Member B forges a snapshot attributed to A → WITH CHECK rejects (42501).
    const forged = await captureAppUserError(
      userB,
      (tx) =>
        tx`
        INSERT INTO note_revisions (note_id, version, title, body, created_by)
        VALUES (${note.id}, 1, 'N', 'b', ${fx.userId})
      `,
    );
    expect(forged.code).toBe("42501");

    // B may attribute a snapshot to themselves, or leave it unattributed (NULL).
    const c = appUserConnect();
    const rows = await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${userB}, true)`;
      return tx<{ id: string }[]>`
        INSERT INTO note_revisions (note_id, version, title, body, created_by)
        VALUES (${note.id}, 2, 'N', 'b', ${userB}),
               (${note.id}, 3, 'N', 'b', NULL)
        RETURNING id
      `;
    });
    expect(rows.length).toBe(2);
  });

  test("note_task_links: app_user inserts a same-project pair (RLS + restrictive floor allow it)", async () => {
    const fx = await seedUserOrgProject("notes-ntl-floor-ok");
    const su = superuserPool();
    const [note] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${fx.projectId}, 'N', 'n', 'team', ${fx.userId}) RETURNING id
    `;
    const [task] = await su<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number)
      VALUES (${fx.projectId}, 'T', 1) RETURNING id
    `;

    const c = appUserConnect();
    const rows = await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
      return tx<{ id: string }[]>`
        INSERT INTO note_task_links (note_id, task_id)
        VALUES (${note.id}, ${task.id})
        RETURNING id
      `;
    });
    expect(rows.length).toBe(1);
  });

  test("notes.body and search_tsv carry lz4 compression (docker/storage.sql applied)", async () => {
    const sql = superuserPool();
    const rows = await sql<{ attname: string; attcompression: string }[]>`
      SELECT attname, attcompression
      FROM pg_attribute
      WHERE attrelid = 'public.notes'::regclass
        AND attname IN ('body', 'search_tsv')
        AND NOT attisdropped
    `;
    const byColumn = Object.fromEntries(
      rows.map((r) => [r.attname, r.attcompression]),
    );
    // 'l' = lz4; 'p'/'' = the pglz default that storage.sql overrides.
    expect(byColumn.body).toBe("l");
    expect(byColumn.search_tsv).toBe("l");
  });

  test("length CHECKs reject oversize title/slug/body with a clean 23514, not an opaque btree/tsvector error", async () => {
    const fx = await seedUserOrgProject("notes-len");
    const su = superuserPool();
    // title > 2000 bytes would otherwise abort with "index row size exceeds
    // btree maximum 2704" on notes_project_title_idx.
    await expectQueryRejects(
      su`
        INSERT INTO notes (project_id, title, slug, created_by)
        VALUES (${fx.projectId}, ${"t".repeat(2001)}, 'len-a', ${fx.userId})
      `,
      /notes_title_len_check/,
    );
    // slug > 2000 bytes would otherwise abort on notes_project_slug_unique.
    await expectQueryRejects(
      su`
        INSERT INTO notes (project_id, title, slug, created_by)
        VALUES (${fx.projectId}, 'ok', ${"s".repeat(2001)}, ${fx.userId})
      `,
      /notes_slug_len_check/,
    );
    // body > 200000 chars would otherwise overflow the generated search_tsv
    // ("string is too long for tsvector") — here it fails as a clean CHECK.
    await expectQueryRejects(
      su`
        INSERT INTO notes (project_id, title, slug, body, created_by)
        VALUES (${fx.projectId}, 'ok', 'len-b', ${"x".repeat(200001)}, ${fx.userId})
      `,
      /notes_body_len_check/,
    );
  });

  test("a max-size body of all-distinct tokens still saves; the left()-bounded search_tsv never overflows", async () => {
    const fx = await seedUserOrgProject("notes-tsv-cap");
    const su = superuserPool();
    // Worst case for tsvector size: ~200000 chars of all-distinct lexemes
    // (the left(body, 200000) bound keeps the generated tsvector well under 1MB).
    const [row] = await su<{ lexemes: number }[]>`
      INSERT INTO notes (project_id, title, slug, body, created_by)
      SELECT ${fx.projectId}, 'big', 'big-note',
             left(string_agg('lx' || g::text, ' '), 200000), ${fx.userId}
      FROM generate_series(1, 200000) g
      RETURNING length(search_tsv) AS lexemes
    `;
    expect(row.lexemes).toBeGreaterThan(0);
  });

  test("notes.created_by: a member cannot NULL out (erase) authorship, but the author-delete FK cascade still nulls it", async () => {
    const fx = await seedUserOrgProject("notes-cb-null");
    const author = await seedSecondMember(fx.organizationId, "notes-cb-author");
    const userB = await seedSecondMember(fx.organizationId, "notes-cb-b");
    const su = superuserPool();
    const [team] = await su<{ id: string }[]>`
      INSERT INTO notes (project_id, title, slug, visibility, created_by)
      VALUES (${fx.projectId}, 'Team', 'team', 'team', ${author})
      RETURNING id
    `;

    // Member B nulls created_by to erase the author → blocked (42501).
    const captured = await captureAppUserError(
      userB,
      (tx) => tx`UPDATE notes SET created_by = NULL WHERE id = ${team.id}`,
    );
    expect(captured.code).toBe("42501");
    expect(captured.message).toMatch(/created_by is immutable/);
    const [before] = await su<{ created_by: string }[]>`
      SELECT created_by FROM notes WHERE id = ${team.id}
    `;
    expect(before.created_by).toBe(author);

    // Deleting the author's user row runs the ON DELETE SET NULL cascade in the
    // table-owner context (not app_user), so the guard lets it through.
    await su`DELETE FROM piyaz_auth."user" WHERE id = ${author}`;
    const [after] = await su<{ created_by: string | null }[]>`
      SELECT created_by FROM notes WHERE id = ${team.id}
    `;
    expect(after.created_by).toBeNull();
  });
});
