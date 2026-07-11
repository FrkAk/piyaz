import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { appUserConnect, seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { captureAppUserError } from "@/tests/setup/expect-query";

afterEach(async () => {
  await truncateAll();
});

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
 * Insert a note owned by the given user via the superuser pool.
 *
 * @param projectId - Project the note belongs to.
 * @param slug - Unique slug within the project.
 * @param visibility - 'team' or 'private'.
 * @param createdBy - Authoring user id.
 * @returns The new note's id.
 */
async function seedNote(
  projectId: string,
  slug: string,
  visibility: "team" | "private",
  createdBy: string,
): Promise<string> {
  const sql = superuserPool();
  const [note] = await sql<{ id: string }[]>`
    INSERT INTO notes (project_id, title, slug, visibility, created_by, shared_since)
    VALUES (${projectId}, ${"Note " + slug}, ${slug}, ${visibility}, ${createdBy},
            CASE WHEN ${visibility} = 'team' THEN now() ELSE NULL END)
    RETURNING id
  `;
  return note.id;
}

/**
 * Flip a note to team visibility via the superuser pool, stamping
 * `shared_since` the way `applyVisibilityTx` does.
 *
 * @param noteId - Note to share.
 */
async function shareNote(noteId: string): Promise<void> {
  const sql = superuserPool();
  await sql`
    UPDATE notes SET visibility = 'team', shared_since = now()
    WHERE id = ${noteId}
  `;
}

/**
 * Insert a revision snapshot via the superuser pool.
 *
 * @param noteId - Note the snapshot belongs to.
 * @param version - Revision counter value.
 * @returns The new revision's id.
 */
async function seedRevision(noteId: string, version: number): Promise<string> {
  const sql = superuserPool();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO note_revisions (note_id, version, title, body)
    VALUES (${noteId}, ${version}, ${"v" + version}, ${"body v" + version})
    RETURNING id
  `;
  return row.id;
}

/**
 * Insert a note-scoped activity event via the superuser pool.
 *
 * @param projectId - Project the event belongs to.
 * @param noteId - Note the event is keyed to.
 * @param summary - Event summary text.
 * @returns The new event's id.
 */
async function seedNoteEvent(
  projectId: string,
  noteId: string,
  summary: string,
): Promise<string> {
  const sql = superuserPool();
  const [event] = await sql<{ id: string }[]>`
    INSERT INTO activity_events (project_id, note_id, type, source, summary)
    VALUES (${projectId}, ${noteId}, 'note_updated', 'web', ${summary})
    RETURNING id
  `;
  return event.id;
}

/**
 * RLS coverage for the activity_events note_id gate. Connects as `app_user`
 * (NOBYPASSRLS) so the policies actually fire, mirroring
 * tests/data/notes-rls.test.ts.
 *
 * Invariants exercised:
 *   - a private note's events are visible only to the note's author; a team
 *     note's events are visible to every project member (USING note-gate
 *     fails closed through notes_member_access);
 *   - the pre-share fence: events and revisions created before the note's
 *     `shared_since` stay creator-only after a private-to-team flip;
 *   - the NULL arm passes task/project rows through untouched, and the
 *     `activity_events_note_ref_check` constraint rejects a note-typed row
 *     without a note_id;
 *   - WITH CHECK rejects an event whose note_id belongs to a foreign project
 *     even when project_id is the caller's own (project pin);
 *   - hard-deleting a note cascades its events (ON DELETE CASCADE, so a
 *     purged note never leaves orphan rows whose gate would blank out).
 */
describe("activity_events RLS: note_id gate, project pin, cascade", () => {
  test("private-note event is author-only; team-note event is member-visible", async () => {
    const fx = await seedUserOrgProject("ae-note-vis");
    const userB = await seedSecondMember(fx.organizationId, "ae-note-vis-b");
    const privNote = await seedNote(fx.projectId, "priv", "private", fx.userId);
    const teamNote = await seedNote(fx.projectId, "team", "team", fx.userId);
    const privEvent = await seedNoteEvent(fx.projectId, privNote, "edited p");
    const teamEvent = await seedNoteEvent(fx.projectId, teamNote, "edited t");

    const c = appUserConnect();
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM activity_events WHERE id IN (${privEvent}, ${teamEvent})
      `;
      expect(rows.map((r) => r.id).sort()).toEqual(
        [privEvent, teamEvent].sort(),
      );
    });
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${userB}, true)`;
      const privRows = await tx<{ id: string }[]>`
        SELECT id FROM activity_events WHERE id = ${privEvent}
      `;
      expect(privRows.length).toBe(0);
      const teamRows = await tx<{ id: string }[]>`
        SELECT id FROM activity_events WHERE id = ${teamEvent}
      `;
      expect(teamRows.length).toBe(1);
    });
  });

  test("pre-share events stay creator-only after a private-to-team flip", async () => {
    const fx = await seedUserOrgProject("ae-note-fence");
    const userB = await seedSecondMember(fx.organizationId, "ae-note-fence-b");
    const note = await seedNote(fx.projectId, "fenced", "private", fx.userId);
    const preShare = await seedNoteEvent(fx.projectId, note, "private edit");
    await shareNote(note);
    const postShare = await seedNoteEvent(fx.projectId, note, "shared edit");

    const c = appUserConnect();
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM activity_events WHERE id IN (${preShare}, ${postShare})
      `;
      expect(rows.map((r) => r.id).sort()).toEqual(
        [preShare, postShare].sort(),
      );
    });
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${userB}, true)`;
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM activity_events WHERE id IN (${preShare}, ${postShare})
      `;
      expect(rows.map((r) => r.id)).toEqual([postShare]);
    });
  });

  test("pre-share revisions stay creator-only after a private-to-team flip", async () => {
    const fx = await seedUserOrgProject("ae-rev-fence");
    const userB = await seedSecondMember(fx.organizationId, "ae-rev-fence-b");
    const note = await seedNote(
      fx.projectId,
      "rev-fenced",
      "private",
      fx.userId,
    );
    const preShare = await seedRevision(note, 1);
    await shareNote(note);
    const postShare = await seedRevision(note, 2);

    const c = appUserConnect();
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM note_revisions WHERE note_id = ${note}
      `;
      expect(rows.map((r) => r.id).sort()).toEqual(
        [preShare, postShare].sort(),
      );
    });
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${userB}, true)`;
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM note_revisions WHERE note_id = ${note}
      `;
      expect(rows.map((r) => r.id)).toEqual([postShare]);
    });
  });

  test("NULL note_id passes task rows through; note-typed rows require note_id", async () => {
    const fx = await seedUserOrgProject("ae-note-null");
    const userB = await seedSecondMember(fx.organizationId, "ae-note-null-b");
    const su = superuserPool();
    const [event] = await su<{ id: string }[]>`
      INSERT INTO activity_events (project_id, type, source, summary)
      VALUES (${fx.projectId}, 'status_changed', 'web', 'task event')
      RETURNING id
    `;

    const c = appUserConnect();
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${userB}, true)`;
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM activity_events WHERE id = ${event.id}
      `;
      expect(rows.length).toBe(1);
    });

    let checkViolation: { code?: string } | null = null;
    try {
      await su`
        INSERT INTO activity_events (project_id, type, source, summary)
        VALUES (${fx.projectId}, 'note_created', 'web', 'no note_id')
      `;
    } catch (err) {
      checkViolation = err as { code?: string };
    }
    expect(checkViolation?.code).toBe("23514");
  });

  test("WITH CHECK rejects an event pinning a foreign-project note (42501)", async () => {
    const teamA = await seedUserOrgProject("ae-note-pin-a");
    const teamB = await seedUserOrgProject("ae-note-pin-b");
    const su = superuserPool();
    await su`
      INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
      VALUES (${teamB.organizationId}, ${teamA.userId}, 'member', now())
    `;
    const foreignNote = await seedNote(
      teamB.projectId,
      "foreign",
      "team",
      teamA.userId,
    );

    const captured = await captureAppUserError(
      teamA.userId,
      (tx) =>
        tx`
        INSERT INTO activity_events (project_id, note_id, type, source, summary)
        VALUES (${teamA.projectId}, ${foreignNote}, 'note_updated', 'web', 'sneak')
      `,
    );
    expect(captured.code).toBe("42501");
  });

  test("hard-deleting a note cascades its activity events", async () => {
    const fx = await seedUserOrgProject("ae-note-cascade");
    const note = await seedNote(fx.projectId, "gone", "team", fx.userId);
    await seedNoteEvent(fx.projectId, note, "created");
    await seedNoteEvent(fx.projectId, note, "edited");

    const su = superuserPool();
    await su`DELETE FROM notes WHERE id = ${note}`;

    const [{ n }] = await su<{ n: number }[]>`
      SELECT count(*)::int AS n FROM activity_events WHERE note_id = ${note}
    `;
    expect(n).toBe(0);
  });
});
