import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedSecondMember, seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { makeAuthContext, type AuthContext } from "@/lib/auth/context";
import {
  listNoteActivity,
  listProjectActivity,
  listTaskActivity,
} from "@/lib/data/activity";
import {
  createNote,
  createNoteTaskLink,
  deleteNote,
  restoreNote,
  updateNote,
} from "@/lib/data/note";
import { ForbiddenError } from "@/lib/auth/authorization";

afterEach(async () => {
  await truncateAll();
});

/**
 * Build an MCP-source auth context for the given user.
 *
 * @param userId - Verified user id.
 * @returns Auth context whose actor source is `mcp`.
 */
function mcpContext(userId: string): AuthContext {
  return makeAuthContext(userId, { source: "mcp", userId, clientId: null });
}

/**
 * Insert a task via the superuser pool.
 *
 * @param projectId - Project the task belongs to.
 * @returns The new task's id.
 */
async function seedTask(projectId: string): Promise<string> {
  const sql = superuserPool();
  const [task] = await sql<{ id: string }[]>`
    INSERT INTO tasks (project_id, title, sequence_number)
    VALUES (${projectId}, 'T', 1) RETURNING id
  `;
  return task.id;
}

describe("listNoteActivity: per-note history, gates, paging", () => {
  test("author pages a private note's history; a second member is 404-shaped", async () => {
    const fx = await seedUserOrgProject("na-priv");
    const userB = await seedSecondMember(fx.organizationId, "na-priv-b");
    const ctxA = makeAuthContext(fx.userId);

    const note = await createNote(ctxA, {
      projectId: fx.projectId,
      title: "Secret plan",
    });
    await updateNote(ctxA, note.id, { body: "step one" });

    const page = await listNoteActivity(ctxA, note.id, {});
    expect(page.events.map((e) => e.type)).toEqual([
      "note_updated",
      "note_created",
    ]);
    expect(page.nextCursor).toBeNull();

    await expect(
      listNoteActivity(makeAuthContext(userB), note.id, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("keyset pagination walks a note's history without gaps", async () => {
    const fx = await seedUserOrgProject("na-page");
    const ctx = makeAuthContext(fx.userId);
    const note = await createNote(ctx, {
      projectId: fx.projectId,
      title: "Paged",
      visibility: "team",
    });
    await updateNote(ctx, note.id, { body: "one" });
    await updateNote(ctx, note.id, { body: "two" });

    const first = await listNoteActivity(ctx, note.id, { limit: 2 });
    expect(first.events.length).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listNoteActivity(ctx, note.id, {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.events.length).toBe(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.events, ...second.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });

  test("a trashed note's history is 404-shaped", async () => {
    const fx = await seedUserOrgProject("na-trash");
    const ctx = makeAuthContext(fx.userId);
    const note = await createNote(ctx, {
      projectId: fx.projectId,
      title: "Gone",
      visibility: "team",
    });
    await deleteNote(ctx, note.id);

    await expect(listNoteActivity(ctx, note.id, {})).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("MCP actor: private and feed-off team notes are 404-shaped; a feed-enabled team note pages", async () => {
    const fx = await seedUserOrgProject("na-mcp");
    const ctx = makeAuthContext(fx.userId);
    const mcp = mcpContext(fx.userId);

    const priv = await createNote(ctx, {
      projectId: fx.projectId,
      title: "Private",
    });
    const feedOff = await createNote(ctx, {
      projectId: fx.projectId,
      title: "Feed off",
      visibility: "team",
    });
    const exposed = await createNote(ctx, {
      projectId: fx.projectId,
      title: "Exposed",
      visibility: "team",
      feedMode: "all",
    });

    await expect(listNoteActivity(mcp, priv.id, {})).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(listNoteActivity(mcp, feedOff.id, {})).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const page = await listNoteActivity(mcp, exposed.id, {});
    expect(page.events.map((e) => e.type)).toEqual(["note_created"]);
  });
});

describe("feed exposure: project and task scopes", () => {
  test("private-note events are excluded from the project feed for every member, author included", async () => {
    const fx = await seedUserOrgProject("na-feed");
    const userB = await seedSecondMember(fx.organizationId, "na-feed-b");
    const ctxA = makeAuthContext(fx.userId);

    const priv = await createNote(ctxA, {
      projectId: fx.projectId,
      title: "Hidden agenda",
    });
    await updateNote(ctxA, priv.id, { body: "quiet" });
    const team = await createNote(ctxA, {
      projectId: fx.projectId,
      title: "Public roadmap",
      visibility: "team",
    });

    for (const ctx of [ctxA, makeAuthContext(userB)]) {
      const feed = await listProjectActivity(ctx, fx.projectId, {});
      const noteEvents = feed.events.filter((e) => e.type.startsWith("note_"));
      expect(noteEvents.length).toBe(1);
      expect(noteEvents[0].summary).toContain("Public roadmap");
      expect(JSON.stringify(feed.events)).not.toContain("Hidden agenda");
    }
    expect(team.id).toBeTruthy();
  });

  test("task feed excludes a private note's link events; MCP additionally loses feed-off team notes", async () => {
    const fx = await seedUserOrgProject("na-taskfeed");
    const ctx = makeAuthContext(fx.userId);
    const taskId = await seedTask(fx.projectId);

    const priv = await createNote(ctx, {
      projectId: fx.projectId,
      title: "Private link",
    });
    const feedOff = await createNote(ctx, {
      projectId: fx.projectId,
      title: "Feed off link",
      visibility: "team",
    });
    const exposed = await createNote(ctx, {
      projectId: fx.projectId,
      title: "Exposed link",
      visibility: "team",
      feedMode: "all",
    });
    await createNoteTaskLink(ctx, priv.id, taskId, "reference");
    await createNoteTaskLink(ctx, feedOff.id, taskId, "reference");
    await createNoteTaskLink(ctx, exposed.id, taskId, "reference");

    const webFeed = await listTaskActivity(ctx, taskId, {});
    const webSummaries = webFeed.events.map((e) => e.summary);
    expect(webSummaries.some((s) => s.includes("Feed off link"))).toBe(true);
    expect(webSummaries.some((s) => s.includes("Exposed link"))).toBe(true);
    expect(JSON.stringify(webFeed.events)).not.toContain("Private link");

    const mcpFeed = await listTaskActivity(mcpContext(fx.userId), taskId, {});
    const mcpSummaries = mcpFeed.events.map((e) => e.summary);
    expect(mcpSummaries.some((s) => s.includes("Exposed link"))).toBe(true);
    expect(JSON.stringify(mcpFeed.events)).not.toContain("Feed off link");
    expect(JSON.stringify(mcpFeed.events)).not.toContain("Private link");
  });

  test("MCP project feed excludes feed-off team notes; web keeps them", async () => {
    const fx = await seedUserOrgProject("na-mcpfeed");
    const ctx = makeAuthContext(fx.userId);

    await createNote(ctx, {
      projectId: fx.projectId,
      title: "Quiet team note",
      visibility: "team",
    });
    await createNote(ctx, {
      projectId: fx.projectId,
      title: "Loud team note",
      visibility: "team",
      feedMode: "all",
    });

    const webFeed = await listProjectActivity(ctx, fx.projectId, {});
    expect(JSON.stringify(webFeed.events)).toContain("Quiet team note");
    expect(JSON.stringify(webFeed.events)).toContain("Loud team note");

    const mcpFeed = await listProjectActivity(
      mcpContext(fx.userId),
      fx.projectId,
      {},
    );
    expect(JSON.stringify(mcpFeed.events)).not.toContain("Quiet team note");
    expect(JSON.stringify(mcpFeed.events)).toContain("Loud team note");
  });

  test("task events with a NULL note_id keep flowing in the feed", async () => {
    const fx = await seedUserOrgProject("na-null-arm");
    const su = superuserPool();
    await su`
      INSERT INTO activity_events (project_id, type, source, summary)
      VALUES (${fx.projectId}, 'status_changed', 'web', 'moved task to doing')
    `;

    const feed = await listProjectActivity(
      makeAuthContext(fx.userId),
      fx.projectId,
      {},
    );
    expect(JSON.stringify(feed.events)).toContain("moved task to doing");
  });

  test("sharing a private note exposes only post-share events in the feed and history", async () => {
    const fx = await seedUserOrgProject("na-share-fence");
    const userB = await seedSecondMember(fx.organizationId, "na-share-b");
    const ctxA = makeAuthContext(fx.userId);
    const note = await createNote(ctxA, {
      projectId: fx.projectId,
      title: "Draft thoughts",
      body: "private era",
      visibility: "private",
    });
    await updateNote(ctxA, note.id, { title: "Roadmap" });
    await updateNote(ctxA, note.id, { visibility: "team" });
    await updateNote(ctxA, note.id, { body: "shared era" });

    const ctxB = makeAuthContext(userB);
    const feedB = await listProjectActivity(ctxB, fx.projectId, {});
    const feedText = JSON.stringify(feedB.events);
    expect(feedText).not.toContain("created note");
    expect(feedText).toContain("updated note");

    const historyB = await listNoteActivity(ctxB, note.id, {});
    const historyText = JSON.stringify(historyB.events);
    expect(historyText).not.toContain("created note");
    const preShareCount = historyB.events.filter(
      (e) => e.type === "note_created",
    ).length;
    expect(preShareCount).toBe(0);

    const historyA = await listNoteActivity(ctxA, note.id, {});
    expect(
      historyA.events.filter((e) => e.type === "note_created").length,
    ).toBe(1);
  });

  test("a trashed team note keeps only its trash event in the feed until restored", async () => {
    const fx = await seedUserOrgProject("na-trash-feed");
    const ctx = makeAuthContext(fx.userId);
    const note = await createNote(ctx, {
      projectId: fx.projectId,
      title: "Doomed",
      body: "content",
      visibility: "team",
    });
    await updateNote(ctx, note.id, { body: "edited" });
    await deleteNote(ctx, note.id);

    const trashedFeed = await listProjectActivity(ctx, fx.projectId, {});
    const trashedTypes = trashedFeed.events
      .filter((e) => e.type.startsWith("note_"))
      .map((e) => e.type);
    expect(trashedTypes).toEqual(["note_deleted"]);

    await restoreNote(ctx, note.id);
    const restoredFeed = await listProjectActivity(ctx, fx.projectId, {});
    const restoredTypes = restoredFeed.events
      .filter((e) => e.type.startsWith("note_"))
      .map((e) => e.type);
    expect(restoredTypes).toContain("note_created");
    expect(restoredTypes).toContain("note_updated");
    expect(restoredTypes).toContain("note_restored");
  });
});
