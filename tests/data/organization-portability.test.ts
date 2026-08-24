/** Integration coverage for organization workspace export and import data paths. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  exportOrganizationWorkspace,
  importOrganizationWorkspace,
  OrganizationExportForbiddenError,
} from "@/lib/data/organization-portability";
import type { OrganizationArchive } from "@/lib/organization-portability/archive";
import { superuserPool } from "@/tests/setup/global";
import { truncateAll } from "@/tests/setup/schema";
import { seedSecondMember, seedUserOrgProject } from "@/tests/setup/seed";

const T1 = "2026-08-24T10:00:00.000Z";
const T2 = "2026-08-24T11:00:00.000Z";
const T3 = "2026-08-24T12:00:00.000Z";
const T4 = "2026-08-24T13:00:00.000Z";

type PortableWorkspaceFixture = {
  ownerUserId: string;
  otherUserId: string;
  otherEmail: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  targetTaskId: string;
  criterionId: string;
  decisionId: string;
  ownerPrivateNoteId: string;
  teamNoteId: string;
};

type EmptyOrganizationFixture = {
  userId: string;
  organizationId: string;
};

/**
 * Seed an organization with one owner and no workspace rows.
 *
 * @param suffix - Unique fixture suffix.
 * @returns Destination owner and organization ids.
 */
async function seedEmptyOwnedOrganization(
  suffix: string,
): Promise<EmptyOrganizationFixture> {
  const sql = superuserPool();
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
    VALUES (${`Importer ${suffix}`}, ${`importer-${suffix}@test.local`}, true, now())
    RETURNING id
  `;
  const [organization] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
    VALUES (${`Imported ${suffix}`}, ${`imported-${suffix}`}, now())
    RETURNING id
  `;
  await sql`
    INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
    VALUES (${organization.id}, ${user.id}, 'owner', now())
  `;
  return { userId: user.id, organizationId: organization.id };
}

/**
 * Sort canonical rows without depending on remapped UUID order.
 *
 * @param rows - Canonical row values.
 * @returns Copy sorted by stable JSON form.
 */
function sortCanonical<T>(rows: T[]): T[] {
  return rows.toSorted((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

/**
 * Remove archive-local ids while retaining every portable field and relation.
 *
 * @param archive - Source or restored organization archive.
 * @param imported - Whether note authors should reflect import normalization.
 * @returns Canonical workspace value suitable for round-trip comparison.
 */
function canonicalWorkspace(
  archive: OrganizationArchive,
  imported: boolean,
): Record<string, unknown> {
  const projectRefs = new Map(
    archive.projects.map((project) => [project.sourceId, project.identifier]),
  );
  const taskRefs = new Map(
    archive.tasks.map((task) => [
      task.sourceId,
      `${projectRefs.get(task.projectSourceId)}#${task.sequenceNumber}`,
    ]),
  );
  const noteRefs = new Map(
    archive.notes.map((note) => [
      note.sourceId,
      `${projectRefs.get(note.projectSourceId)}#note-${note.sequenceNumber}`,
    ]),
  );
  const criterionRefs = new Map(
    archive.taskAcceptanceCriteria.map((criterion) => [
      criterion.sourceId,
      `${taskRefs.get(criterion.taskSourceId)}#criterion-${criterion.position}`,
    ]),
  );
  const decisionRefs = new Map(
    archive.taskDecisions.map((decision) => [
      decision.sourceId,
      `${taskRefs.get(decision.taskSourceId)}#decision-${decision.position}`,
    ]),
  );
  const eventTarget = (
    event: OrganizationArchive["activityEvents"][number],
  ): string | null => {
    if (event.targetRef === null) return null;
    if (event.type.startsWith("criterion_")) {
      return criterionRefs.get(event.targetRef) ?? null;
    }
    if (event.type.startsWith("decision_")) {
      return decisionRefs.get(event.targetRef) ?? null;
    }
    if (event.type.startsWith("edge_")) {
      return taskRefs.get(event.targetRef) ?? null;
    }
    return event.targetRef;
  };

  return {
    projects: sortCanonical(
      archive.projects.map(({ sourceId: _sourceId, ...project }) => project),
    ),
    tasks: sortCanonical(
      archive.tasks.map(
        ({ sourceId: _sourceId, projectSourceId, ...task }) => ({
          ...task,
          projectRef: projectRefs.get(projectSourceId),
        }),
      ),
    ),
    taskEdges: sortCanonical(
      archive.taskEdges.map(
        ({
          sourceId: _sourceId,
          sourceTaskSourceId,
          targetTaskSourceId,
          ...edge
        }) => ({
          ...edge,
          sourceTaskRef: taskRefs.get(sourceTaskSourceId),
          targetTaskRef: taskRefs.get(targetTaskSourceId),
        }),
      ),
    ),
    taskAssignments: sortCanonical(
      archive.taskAssignments.map(({ taskSourceId, ...assignment }) => ({
        ...assignment,
        taskRef: taskRefs.get(taskSourceId),
      })),
    ),
    taskAcceptanceCriteria: sortCanonical(
      archive.taskAcceptanceCriteria.map(
        ({ sourceId: _sourceId, taskSourceId, ...criterion }) => ({
          ...criterion,
          taskRef: taskRefs.get(taskSourceId),
        }),
      ),
    ),
    taskDecisions: sortCanonical(
      archive.taskDecisions.map(
        ({ sourceId: _sourceId, taskSourceId, ...decision }) => ({
          ...decision,
          taskRef: taskRefs.get(taskSourceId),
        }),
      ),
    ),
    taskLinks: sortCanonical(
      archive.taskLinks.map(
        ({ sourceId: _sourceId, taskSourceId, ...link }) => ({
          ...link,
          taskRef: taskRefs.get(taskSourceId),
        }),
      ),
    ),
    activityEvents: sortCanonical(
      archive.activityEvents.map(
        ({
          sourceId: _sourceId,
          projectSourceId,
          taskSourceId,
          noteSourceId,
          targetRef: _targetRef,
          ...event
        }) => ({
          ...event,
          projectRef: projectRefs.get(projectSourceId),
          taskRef: taskSourceId ? taskRefs.get(taskSourceId) : null,
          noteRef: noteSourceId ? noteRefs.get(noteSourceId) : null,
          targetRef: eventTarget(
            archive.activityEvents.find(
              (candidate) => candidate.sourceId === _sourceId,
            )!,
          ),
        }),
      ),
    ),
    notes: sortCanonical(
      archive.notes.map(
        ({ sourceId: _sourceId, projectSourceId, ...note }) => ({
          ...note,
          createdBy: imported ? "exporter" : note.createdBy,
          projectRef: projectRefs.get(projectSourceId),
        }),
      ),
    ),
    noteFolders: sortCanonical(
      archive.noteFolders.map(
        ({ sourceId: _sourceId, projectSourceId, ...folder }) => ({
          ...folder,
          projectRef: projectRefs.get(projectSourceId),
        }),
      ),
    ),
    noteTaskLinks: sortCanonical(
      archive.noteTaskLinks.map(
        ({ sourceId: _sourceId, noteSourceId, taskSourceId, ...link }) => ({
          ...link,
          noteRef: noteRefs.get(noteSourceId),
          taskRef: taskRefs.get(taskSourceId),
        }),
      ),
    ),
    noteFeedTasks: sortCanonical(
      archive.noteFeedTasks.map(
        ({ sourceId: _sourceId, noteSourceId, taskSourceId, ...link }) => ({
          ...link,
          noteRef: noteRefs.get(noteSourceId),
          taskRef: taskRefs.get(taskSourceId),
        }),
      ),
    ),
    noteLinks: sortCanonical(
      archive.noteLinks.map(
        ({
          sourceId: _sourceId,
          sourceNoteSourceId,
          targetNoteSourceId,
          ...link
        }) => ({
          ...link,
          sourceNoteRef: noteRefs.get(sourceNoteSourceId),
          targetNoteRef: noteRefs.get(targetNoteSourceId),
        }),
      ),
    ),
    noteRevisions: sortCanonical(
      archive.noteRevisions.map(
        ({ sourceId: _sourceId, noteSourceId, ...revision }) => ({
          ...revision,
          noteRef: noteRefs.get(noteSourceId),
        }),
      ),
    ),
  };
}

/**
 * Seed one organization with every workspace table and privacy boundary.
 *
 * @param suffix - Unique fixture suffix.
 * @returns Source ids used by export assertions.
 */
async function seedPortableWorkspace(
  suffix: string,
): Promise<PortableWorkspaceFixture> {
  const base = await seedUserOrgProject(suffix);
  const otherUserId = await seedSecondMember(
    base.organizationId,
    `${suffix}-other`,
  );
  const sql = superuserPool();
  const otherEmail = `user${suffix}-other@test.local`;
  const criterionId = crypto.randomUUID();
  const decisionId = crypto.randomUUID();

  await sql`
    UPDATE piyaz_auth."organization"
    SET "name" = 'Portable Team', "slug" = ${`portable-${suffix}`}
    WHERE id = ${base.organizationId}
  `;
  await sql`
    UPDATE projects
    SET title = 'Migration project', identifier = 'MOVE',
        description = 'Move this workspace', status = 'active',
        categories = '["Backend","Docs"]'::jsonb
    WHERE id = ${base.projectId}
  `;
  const [task] = await sql<{ id: string }[]>`
    INSERT INTO tasks (
      project_id, title, sequence_number, description, status, "order",
      category, implementation_plan, execution_record, tags, priority,
      estimate, files, created_at, updated_at, meta_updated_at
    ) VALUES (
      ${base.projectId}, 'Export workspace', 1, 'Keep all data',
      'in_progress', 0, 'Backend', 'Read under RLS', 'Archive assembled',
      '["migration"]'::jsonb, 'core', 3, '["lib/export.ts"]'::jsonb,
      ${T1}, ${T2}, ${T2}
    ) RETURNING id
  `;
  const [targetTask] = await sql<{ id: string }[]>`
    INSERT INTO tasks (
      project_id, title, sequence_number, status, "order",
      created_at, updated_at, meta_updated_at
    ) VALUES (
      ${base.projectId}, 'Import workspace', 2, 'draft', 1,
      ${T1}, ${T2}, ${T2}
    ) RETURNING id
  `;
  await sql`
    INSERT INTO task_edges (
      source_task_id, target_task_id, edge_type, note,
      created_at, updated_at, meta_updated_at
    ) VALUES (
      ${task.id}, ${targetTask.id}, 'depends_on', 'Export before import',
      ${T2}, ${T2}, ${T2}
    )
  `;
  await sql`
    INSERT INTO task_assignees (task_id, user_id, created_at)
    VALUES
      (${task.id}, ${base.userId}, ${T2}),
      (${task.id}, ${otherUserId}, ${T3})
  `;
  await sql`
    INSERT INTO task_acceptance_criteria (
      id, task_id, text, checked, position, created_at, updated_at
    ) VALUES (
      ${criterionId}, ${task.id}, 'Archive validates', true, 0, ${T2}, ${T3}
    )
  `;
  await sql`
    INSERT INTO task_decisions (
      id, task_id, text, source, decision_date, position, created_at, updated_at
    ) VALUES (
      ${decisionId}, ${task.id}, 'Use JSON', 'planning', '2026-08-24', 0,
      ${T2}, ${T3}
    )
  `;
  await sql`
    INSERT INTO task_links (
      task_id, kind, url, label, created_at, created_by, metadata
    ) VALUES
      (${task.id}, 'documentation', 'https://example.test/owner', 'Owner docs',
       ${T2}, ${base.userId}, '{"owner":true}'::jsonb),
      (${task.id}, 'issue', 'https://example.test/member', 'Member issue',
       ${T3}, ${otherUserId}, '{"owner":false}'::jsonb)
  `;
  const [ownerPrivateNote] = await sql<{ id: string }[]>`
    INSERT INTO notes (
      project_id, sequence_number, type, folder, title, slug, summary, body,
      visibility, agent_writable, locked, feed_mode, feed_categories,
      feed_tags, tags, category, version, embedding_status, created_by,
      updated_by, created_at, updated_at, meta_updated_at
    ) VALUES (
      ${base.projectId}, 1, 'guidance', 'Migration', 'Owner plan', 'owner-plan',
      'Private migration plan', 'owner private body', 'private', true, false,
      'tasks', '[]'::jsonb, '[]'::jsonb, '["portable"]'::jsonb, 'Backend', 2,
      'ready', ${base.userId}, ${base.userId}, ${T1}, ${T3}, ${T3}
    ) RETURNING id
  `;
  const [otherPrivateNote] = await sql<{ id: string }[]>`
    INSERT INTO notes (
      project_id, sequence_number, title, slug, body, visibility, created_by,
      created_at, updated_at, meta_updated_at
    ) VALUES (
      ${base.projectId}, 2, 'Other private', 'other-private',
      'other member private body', 'private', ${otherUserId}, ${T1}, ${T2}, ${T2}
    ) RETURNING id
  `;
  const [teamNote] = await sql<{ id: string }[]>`
    INSERT INTO notes (
      project_id, sequence_number, type, folder, title, slug, summary, body,
      visibility, shared_since, feed_mode, feed_categories, tags, category,
      version, embedding_status, created_by, updated_by, created_at, updated_at,
      meta_updated_at, deleted_at
    ) VALUES (
      ${base.projectId}, 3, 'reference', 'Migration', 'Shared guide',
      'shared-guide', 'Shared migration notes', 'shared note body', 'team', ${T3},
      'categories', '["Backend"]'::jsonb, '["shared"]'::jsonb, 'Docs', 2,
      'stale', ${otherUserId}, ${otherUserId}, ${T1}, ${T4}, ${T4}, ${T4}
    ) RETURNING id
  `;
  await sql`
    INSERT INTO note_folders (project_id, path, created_by, created_at)
    VALUES (${base.projectId}, 'Migration', ${base.userId}, ${T1})
  `;
  await sql`
    INSERT INTO note_task_links (note_id, task_id, kind, created_at)
    VALUES
      (${ownerPrivateNote.id}, ${task.id}, 'spec_of', ${T2}),
      (${teamNote.id}, ${targetTask.id}, 'reference', ${T3}),
      (${otherPrivateNote.id}, ${task.id}, 'mention', ${T2})
  `;
  await sql`
    INSERT INTO note_feed_tasks (note_id, task_id, created_at)
    VALUES
      (${ownerPrivateNote.id}, ${task.id}, ${T2}),
      (${teamNote.id}, ${targetTask.id}, ${T3}),
      (${otherPrivateNote.id}, ${task.id}, ${T2})
  `;
  await sql`
    INSERT INTO note_links (source_note_id, target_note_id, created_at)
    VALUES
      (${ownerPrivateNote.id}, ${teamNote.id}, ${T3}),
      (${otherPrivateNote.id}, ${teamNote.id}, ${T2})
  `;
  await sql`
    INSERT INTO note_revisions (
      note_id, version, title, body, created_by, created_at
    ) VALUES
      (${ownerPrivateNote.id}, 1, 'Owner plan', 'owner revision body',
       ${base.userId}, ${T2}),
      (${otherPrivateNote.id}, 1, 'Other private', 'other revision body',
       ${otherUserId}, ${T2}),
      (${teamNote.id}, 1, 'Shared guide', 'pre-share revision body',
       ${otherUserId}, ${T2}),
      (${teamNote.id}, 2, 'Shared guide', 'post-share revision body',
       ${otherUserId}, ${T4})
  `;
  await sql`
    INSERT INTO activity_events (
      project_id, task_id, note_id, type, created_at, actor_user_id, source,
      actor_client_id, summary, target_ref, metadata
    ) VALUES
      (${base.projectId}, NULL, NULL, 'project_created', ${T1}, ${base.userId},
       'web', NULL, 'created the project', NULL, NULL),
      (${base.projectId}, ${task.id}, NULL, 'status_changed', ${T2},
       ${otherUserId}, 'mcp', 'private-client', 'changed status to active', NULL,
       '{"from":"draft","to":"active"}'::jsonb),
      (${base.projectId}, ${task.id}, NULL, 'criterion_added',
       ${"2026-08-24T11:10:00.000Z"}, ${base.userId}, 'web', NULL,
       'added criterion', ${criterionId}, NULL),
      (${base.projectId}, ${task.id}, NULL, 'edge_added',
       ${"2026-08-24T11:20:00.000Z"}, ${base.userId}, 'web', NULL,
       'added dependency', ${targetTask.id}, NULL),
      (${base.projectId}, ${task.id}, NULL, 'assignee_added',
       ${"2026-08-24T11:30:00.000Z"}, ${otherUserId}, 'web', NULL,
       'assigned another member', ${otherUserId}, NULL),
      (${base.projectId}, NULL, ${ownerPrivateNote.id}, 'note_updated',
       ${"2026-08-24T11:40:00.000Z"}, ${base.userId}, 'web', NULL,
       'updated owner note', NULL, NULL),
      (${base.projectId}, NULL, ${teamNote.id}, 'note_updated', ${T2},
       ${otherUserId}, 'web', NULL, 'private shared-note edit', NULL, NULL),
      (${base.projectId}, NULL, ${teamNote.id}, 'note_updated', ${T4},
       ${otherUserId}, 'web', NULL, 'updated migration note', NULL, NULL),
      (${base.projectId}, NULL, ${otherPrivateNote.id}, 'note_updated', ${T4},
       ${otherUserId}, 'web', NULL, 'updated other private note', NULL, NULL)
  `;
  await sql`
    UPDATE tasks
    SET created_at = ${T1}, updated_at = ${T2}, meta_updated_at = ${T2}
    WHERE project_id = ${base.projectId}
  `;
  await sql`
    UPDATE projects
    SET created_at = ${T1}, updated_at = ${T4}, meta_updated_at = ${T4}
    WHERE id = ${base.projectId}
  `;

  return {
    ownerUserId: base.userId,
    otherUserId,
    otherEmail,
    organizationId: base.organizationId,
    projectId: base.projectId,
    taskId: task.id,
    targetTaskId: targetTask.id,
    criterionId,
    decisionId,
    ownerPrivateNoteId: ownerPrivateNote.id,
    teamNoteId: teamNote.id,
  };
}

afterEach(async () => {
  await truncateAll();
});

describe("exportOrganizationWorkspace", () => {
  test("exports every visible workspace row and complete history", async () => {
    const fixture = await seedPortableWorkspace("export-complete");

    const archive = await exportOrganizationWorkspace(
      fixture.ownerUserId,
      fixture.organizationId,
    );

    expect(archive.format).toBe("piyaz-organization");
    expect(archive.version).toBe(1);
    expect(archive.organization).toEqual({
      name: "Portable Team",
      slug: "portable-export-complete",
    });
    expect(archive.projects).toHaveLength(1);
    expect(archive.tasks).toHaveLength(2);
    expect(archive.taskEdges).toHaveLength(1);
    expect(archive.taskAssignments).toEqual([
      { taskSourceId: fixture.taskId, createdAt: T2 },
    ]);
    expect(archive.taskAcceptanceCriteria).toHaveLength(1);
    expect(archive.taskAcceptanceCriteria[0]).toMatchObject({
      sourceId: fixture.criterionId,
      text: "Archive validates",
      checked: true,
    });
    expect(archive.taskDecisions).toHaveLength(1);
    expect(archive.taskDecisions[0]).toMatchObject({
      sourceId: fixture.decisionId,
      text: "Use JSON",
      source: "planning",
    });
    expect(archive.taskLinks.map((link) => link.createdBy)).toEqual([
      "exporter",
      null,
    ]);
    expect(archive.notes.map((note) => note.sourceId).sort()).toEqual(
      [fixture.ownerPrivateNoteId, fixture.teamNoteId].sort(),
    );
    expect(
      archive.notes.find((note) => note.sourceId === fixture.ownerPrivateNoteId)
        ?.createdBy,
    ).toBe("exporter");
    expect(
      archive.notes.find((note) => note.sourceId === fixture.teamNoteId),
    ).toMatchObject({ createdBy: null, deletedAt: T4 });
    expect(archive.noteFolders).toHaveLength(1);
    expect(archive.noteTaskLinks).toHaveLength(2);
    expect(archive.noteFeedTasks).toHaveLength(2);
    expect(archive.noteLinks).toHaveLength(1);
    expect(archive.noteRevisions.map((revision) => revision.version)).toEqual([
      1, 2,
    ]);
    expect(archive.noteRevisions.map((revision) => revision.body)).toEqual([
      "owner revision body",
      "post-share revision body",
    ]);
    expect(archive.activityEvents.map((event) => event.summary)).toEqual([
      "created the project",
      "changed status to active",
      "added criterion",
      "added dependency",
      "assigned another member",
      "updated owner note",
      "updated migration note",
    ]);
    expect(
      archive.activityEvents.find(
        (event) => event.summary === "added criterion",
      )?.targetRef,
    ).toBe(fixture.criterionId);
    expect(
      archive.activityEvents.find(
        (event) => event.summary === "added dependency",
      )?.targetRef,
    ).toBe(fixture.targetTaskId);
    expect(
      archive.activityEvents.find(
        (event) => event.summary === "assigned another member",
      ),
    ).toMatchObject({ actor: null, targetRef: null });
    expect(new Date(archive.exportedAt).toISOString()).toBe(archive.exportedAt);
  });

  test("does not export another member's private content or identity", async () => {
    const fixture = await seedPortableWorkspace("export-private");

    const archive = await exportOrganizationWorkspace(
      fixture.ownerUserId,
      fixture.organizationId,
    );
    const serialized = JSON.stringify(archive);

    expect(serialized).not.toContain(fixture.otherUserId);
    expect(serialized).not.toContain(fixture.otherEmail);
    expect(serialized).not.toContain("other member private body");
    expect(serialized).not.toContain("other revision body");
    expect(serialized).not.toContain("pre-share revision body");
    expect(serialized).not.toContain("private shared-note edit");
    expect(serialized).not.toContain("updated other private note");
    expect(serialized).not.toContain("private-client");
    expect(archive.taskAssignments).toHaveLength(1);
  });

  test.each(["admin", "member"])(
    "rejects a caller with the %s role",
    async (role) => {
      const fixture = await seedPortableWorkspace(`export-${role}`);
      const sql = superuserPool();
      await sql`
        UPDATE piyaz_auth."member" SET role = ${role}
        WHERE "organizationId" = ${fixture.organizationId}
          AND "userId" = ${fixture.ownerUserId}
      `;

      await expect(
        exportOrganizationWorkspace(
          fixture.ownerUserId,
          fixture.organizationId,
        ),
      ).rejects.toBeInstanceOf(OrganizationExportForbiddenError);
    },
  );

  test("rejects a non-member, missing organization, and malformed id", async () => {
    const owner = await seedUserOrgProject("export-outsider-owner");
    const target = await seedUserOrgProject("export-outsider-target");

    await expect(
      exportOrganizationWorkspace(owner.userId, target.organizationId),
    ).rejects.toBeInstanceOf(OrganizationExportForbiddenError);
    await expect(
      exportOrganizationWorkspace(owner.userId, crypto.randomUUID()),
    ).rejects.toBeInstanceOf(OrganizationExportForbiddenError);
    await expect(
      exportOrganizationWorkspace(owner.userId, "not-a-uuid"),
    ).rejects.toBeInstanceOf(OrganizationExportForbiddenError);
  });
});

describe("importOrganizationWorkspace", () => {
  test("round trips workspace content with fresh ids and preserved history", async () => {
    const source = await seedPortableWorkspace("roundtrip-source");
    const archive = await exportOrganizationWorkspace(
      source.ownerUserId,
      source.organizationId,
    );
    const destination = await seedEmptyOwnedOrganization(
      "roundtrip-destination",
    );

    const summary = await importOrganizationWorkspace(
      destination.userId,
      destination.organizationId,
      archive,
    );
    const restored = await exportOrganizationWorkspace(
      destination.userId,
      destination.organizationId,
    );

    expect(summary).toEqual({
      projectCount: archive.projects.length,
      taskCount: archive.tasks.length,
      noteCount: archive.notes.length,
      activityEventCount: archive.activityEvents.length,
    });
    expect(canonicalWorkspace(restored, false)).toEqual(
      canonicalWorkspace(archive, true),
    );
    const sourceIds = new Set([
      ...archive.projects.map((row) => row.sourceId),
      ...archive.tasks.map((row) => row.sourceId),
      ...archive.notes.map((row) => row.sourceId),
      ...archive.activityEvents.map((row) => row.sourceId),
    ]);
    expect(
      [
        ...restored.projects,
        ...restored.tasks,
        ...restored.notes,
        ...restored.activityEvents,
      ].every((row) => !sourceIds.has(row.sourceId)),
    ).toBe(true);
    expect(restored.taskAssignments).toHaveLength(1);
    expect(restored.notes.every((note) => note.createdBy === "exporter")).toBe(
      true,
    );
    expect(
      restored.activityEvents.find(
        (event) => event.summary === "added criterion",
      )?.targetRef,
    ).toBe(restored.taskAcceptanceCriteria[0]?.sourceId);
    expect(
      restored.activityEvents.find(
        (event) => event.summary === "added dependency",
      )?.targetRef,
    ).toBe(
      restored.tasks.find((task) => task.title === "Import workspace")
        ?.sourceId,
    );
    expect(
      restored.notes.find((note) => note.title === "Shared guide")?.deletedAt,
    ).toBe(T4);
  });

  test("imports the same archive repeatedly with disjoint ids", async () => {
    const source = await seedPortableWorkspace("repeat-source");
    const archive = await exportOrganizationWorkspace(
      source.ownerUserId,
      source.organizationId,
    );
    const firstDestination = await seedEmptyOwnedOrganization("repeat-first");
    const secondDestination = await seedEmptyOwnedOrganization("repeat-second");

    await importOrganizationWorkspace(
      firstDestination.userId,
      firstDestination.organizationId,
      archive,
    );
    await importOrganizationWorkspace(
      secondDestination.userId,
      secondDestination.organizationId,
      archive,
    );
    const first = await exportOrganizationWorkspace(
      firstDestination.userId,
      firstDestination.organizationId,
    );
    const second = await exportOrganizationWorkspace(
      secondDestination.userId,
      secondDestination.organizationId,
    );

    expect(canonicalWorkspace(first, false)).toEqual(
      canonicalWorkspace(second, false),
    );
    const firstIds = new Set([
      ...first.projects.map((row) => row.sourceId),
      ...first.tasks.map((row) => row.sourceId),
      ...first.notes.map((row) => row.sourceId),
      ...first.activityEvents.map((row) => row.sourceId),
    ]);
    expect(
      [
        ...second.projects,
        ...second.tasks,
        ...second.notes,
        ...second.activityEvents,
      ].every((row) => !firstIds.has(row.sourceId)),
    ).toBe(true);
  });

  test("rolls back every workspace row after a database constraint failure", async () => {
    const source = await seedPortableWorkspace("rollback-source");
    const archive = await exportOrganizationWorkspace(
      source.ownerUserId,
      source.organizationId,
    );
    archive.projects.push({
      ...archive.projects[0],
      sourceId: crypto.randomUUID(),
    });
    const destination = await seedEmptyOwnedOrganization("rollback-target");

    await expect(
      importOrganizationWorkspace(
        destination.userId,
        destination.organizationId,
        archive,
      ),
    ).rejects.toThrow();

    const sql = superuserPool();
    const [row] = await sql<{ project_count: number }[]>`
      SELECT count(*)::int AS project_count
      FROM projects
      WHERE organization_id = ${destination.organizationId}
    `;
    expect(row.project_count).toBe(0);
  });
});
