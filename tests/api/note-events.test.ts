import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedSecondMember, seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { broker } from "@/lib/realtime/broker";
import type { RealtimeEvent } from "@/lib/realtime/types";
import {
  GET as getEvents,
  HEAD as headEvents,
} from "@/app/api/note/[noteId]/events/route";
import {
  GET as getRevisions,
  HEAD as headRevisions,
} from "@/app/api/note/[noteId]/revisions/route";
import { makeAuthContext } from "@/lib/auth/context";
import { createNote, deleteNote, moveNote, updateNote } from "@/lib/data/note";
import type { ActivityEvent } from "@/lib/types";

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

afterEach(async () => {
  broker._resetForTests();
  await truncateAll();
});

/** Seed a team note with a body update so it has two events and two revisions. */
async function seedNoteWithHistory(prefix: string) {
  const fx = await seedUserOrgProject(prefix);
  const ctx = makeAuthContext(fx.userId);
  const note = await createNote(ctx, {
    projectId: fx.projectId,
    title: "N",
    body: "one",
    visibility: "team",
  });
  await updateNote(ctx, note.id, { body: "two" });
  return { fx, ctx, noteId: note.id };
}

/**
 * Parse captured SSE frames down to the note-kind realtime events.
 *
 * @param frames - Raw `data: <json>\n\n` frames captured by a fake conn.
 * @returns The decoded note events in dispatch order.
 */
function noteEventsFrom(
  frames: string[],
): Extract<RealtimeEvent, { kind: "note" }>[] {
  return frames
    .map((f) => JSON.parse(f.slice("data: ".length)) as RealtimeEvent)
    .filter((e) => e.kind === "note");
}

const callEvents = (
  noteId: string,
  query = "",
  headers: Record<string, string> = {},
  method: "GET" | "HEAD" = "GET",
) =>
  (method === "HEAD" ? headEvents : getEvents)(
    new Request(`http://test/api/note/${noteId}/events${query}`, {
      method,
      headers,
    }),
    { params: Promise.resolve({ noteId }) },
  );

const callRevisions = (
  noteId: string,
  headers: Record<string, string> = {},
  method: "GET" | "HEAD" = "GET",
) =>
  (method === "HEAD" ? headRevisions : getRevisions)(
    new Request(`http://test/api/note/${noteId}/revisions`, {
      method,
      headers,
    }),
    { params: Promise.resolve({ noteId }) },
  );

describe("GET /api/note/[noteId]/events", () => {
  test("returns the note's events newest-first with a 200", async () => {
    const { fx, noteId } = await seedNoteWithHistory("nev-owner");
    setSession({ user: { id: fx.userId } });

    const res = await callEvents(noteId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: ActivityEvent[];
      nextCursor: string | null;
    };
    expect(body.events.map((e) => e.type)).toEqual([
      "note_updated",
      "note_created",
    ]);
    expect(body.nextCursor).toBeNull();
  });

  test("a second request with the matching ETag returns 304 with no body", async () => {
    const { fx, noteId } = await seedNoteWithHistory("nev-etag");
    setSession({ user: { id: fx.userId } });

    const first = await callEvents(noteId);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    const replay = await callEvents(noteId, "", {
      "if-none-match": etag as string,
    });
    expect(replay.status).toBe(304);
    expect(await replay.text()).toBe("");

    await updateNote(makeAuthContext(fx.userId), noteId, { body: "three" });
    const after = await callEvents(noteId, "", {
      "if-none-match": etag as string,
    });
    expect(after.status).toBe(200);
  });

  test("HEAD returns the ETag and no body", async () => {
    const { fx, noteId } = await seedNoteWithHistory("nev-head");
    setSession({ user: { id: fx.userId } });

    const res = await callEvents(noteId, "", {}, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBeNull();
    expect(await res.text()).toBe("");
  });

  test("honors ?limit and walks the second page via the cursor", async () => {
    const { fx, noteId } = await seedNoteWithHistory("nev-page");
    setSession({ user: { id: fx.userId } });

    const first = await callEvents(noteId, "?limit=1");
    const firstBody = (await first.json()) as {
      events: ActivityEvent[];
      nextCursor: string | null;
    };
    expect(firstBody.events).toHaveLength(1);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await callEvents(
      noteId,
      `?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
    );
    const secondBody = (await second.json()) as {
      events: ActivityEvent[];
      nextCursor: string | null;
    };
    expect(secondBody.events).toHaveLength(1);
    expect(secondBody.events[0].id).not.toBe(firstBody.events[0].id);
  });

  test("event rows carry only the slim note-scoped fields", async () => {
    const { fx, noteId } = await seedNoteWithHistory("nev-slim");
    setSession({ user: { id: fx.userId } });

    const res = await callEvents(noteId);
    const body = (await res.json()) as { events: Record<string, unknown>[] };
    for (const event of body.events) {
      expect(event).not.toContainKey("projectId");
      expect(event).not.toContainKey("taskId");
      expect(event).not.toContainKey("targetRef");
      expect(event).toContainKeys(["id", "type", "createdAt", "summary"]);
    }
  });

  test("the ETag folds the newest event id, so a same-count append moves it", async () => {
    const { fx, noteId } = await seedNoteWithHistory("nev-etag-id");
    setSession({ user: { id: fx.userId } });

    const first = await callEvents(noteId, "?limit=1");
    const firstEtag = first.headers.get("etag") as string;
    const firstBody = (await first.json()) as { events: { id: string }[] };
    expect(firstEtag).toContain(firstBody.events[0].id);

    await updateNote(makeAuthContext(fx.userId), noteId, { body: "three" });
    const after = await callEvents(noteId, "?limit=1", {
      "if-none-match": firstEtag,
    });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(firstEtag);
  });

  test("an oversize limit clamps to the max page size and a tampered cursor falls back to page one", async () => {
    const { fx, noteId } = await seedNoteWithHistory("nev-clamp");
    setSession({ user: { id: fx.userId } });
    await superuserPool()`
      INSERT INTO activity_events
        (project_id, note_id, type, actor_user_id, source, summary, created_at)
      SELECT ${fx.projectId}, ${noteId}, 'note_updated', ${fx.userId}, 'web',
             'edited note', now() - (g || ' milliseconds')::interval
      FROM generate_series(1, 55) g
    `;

    const clamped = await callEvents(noteId, "?limit=5000");
    expect(clamped.status).toBe(200);
    const clampedBody = (await clamped.json()) as {
      events: unknown[];
      nextCursor: string | null;
    };
    expect(clampedBody.events).toHaveLength(50);
    expect(clampedBody.nextCursor).not.toBeNull();

    const tampered = await callEvents(
      noteId,
      `?cursor=${encodeURIComponent("garbage|not-a-cursor")}`,
    );
    expect(tampered.status).toBe(200);
    const tamperedBody = (await tampered.json()) as { events: unknown[] };
    expect(tamperedBody.events).toHaveLength(20);
  });

  test("returns 404 for a non-uuid id before any SQL", async () => {
    const { fx } = await seedNoteWithHistory("nev-uuid");
    setSession({ user: { id: fx.userId } });

    const res = await callEvents("not-a-uuid");
    expect(res.status).toBe(404);
  });

  test("returns 404 for a cross-team caller and for another member on a private note", async () => {
    const { fx, ctx, noteId } = await seedNoteWithHistory("nev-x");
    const stranger = await seedUserOrgProject("nev-stranger");
    setSession({ user: { id: stranger.userId } });
    expect((await callEvents(noteId)).status).toBe(404);

    const priv = await createNote(ctx, {
      projectId: fx.projectId,
      title: "Private note",
    });
    const mate = await seedSecondMember(fx.organizationId, "nev-x-b");
    setSession({ user: { id: mate } });
    const res = await callEvents(priv.id);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Private note");
  });

  test("returns 404 for a trashed note", async () => {
    const { fx, ctx, noteId } = await seedNoteWithHistory("nev-trash");
    await deleteNote(ctx, noteId);
    setSession({ user: { id: fx.userId } });

    expect((await callEvents(noteId)).status).toBe(404);
  });

  test("returns 401 without a session", async () => {
    const { noteId } = await seedNoteWithHistory("nev-noauth");
    setSession(null);

    expect((await callEvents(noteId)).status).toBe(401);
  });

  test("the validator probe 404-shapes HEAD and If-None-Match requests too", async () => {
    const { fx, ctx, noteId } = await seedNoteWithHistory("nev-probe404");
    const stranger = await seedUserOrgProject("nev-probe404-x");
    setSession({ user: { id: stranger.userId } });
    expect(
      (await callEvents(noteId, "", { "if-none-match": '"0-x"' })).status,
    ).toBe(404);

    await deleteNote(ctx, noteId);
    setSession({ user: { id: fx.userId } });
    expect((await callEvents(noteId, "", {}, "HEAD")).status).toBe(404);
  });
});

describe("GET /api/note/[noteId]/revisions", () => {
  test("lists slim revision descriptors newest-first, never the body", async () => {
    const { fx, noteId } = await seedNoteWithHistory("nrev-owner");
    setSession({ user: { id: fx.userId } });

    const res = await callRevisions(noteId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currentVersion: number;
      revisions: { version: number; title: string }[];
    };
    expect(body.currentVersion).toBe(2);
    expect(body.revisions.map((r) => r.version)).toEqual([1]);
    expect(JSON.stringify(body)).not.toContain('"body"');
    expect(JSON.stringify(body)).not.toContain('"createdBy"');
  });

  test("a second request with the matching ETag returns 304; a new revision moves it", async () => {
    const { fx, noteId } = await seedNoteWithHistory("nrev-etag");
    setSession({ user: { id: fx.userId } });

    const first = await callRevisions(noteId);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    const replay = await callRevisions(noteId, {
      "if-none-match": etag as string,
    });
    expect(replay.status).toBe(304);

    await updateNote(makeAuthContext(fx.userId), noteId, { body: "three" });
    const after = await callRevisions(noteId, {
      "if-none-match": etag as string,
    });
    expect(after.status).toBe(200);
  });

  test("HEAD returns the ETag and no body", async () => {
    const { fx, noteId } = await seedNoteWithHistory("nrev-head");
    setSession({ user: { id: fx.userId } });

    const res = await callRevisions(noteId, {}, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBeNull();
    expect(await res.text()).toBe("");
  });

  test("returns 404 for a non-uuid id, a cross-team caller, and a trashed note", async () => {
    const { fx, ctx, noteId } = await seedNoteWithHistory("nrev-x");
    setSession({ user: { id: fx.userId } });
    expect((await callRevisions("not-a-uuid")).status).toBe(404);

    const stranger = await seedUserOrgProject("nrev-stranger");
    setSession({ user: { id: stranger.userId } });
    expect((await callRevisions(noteId)).status).toBe(404);

    await deleteNote(ctx, noteId);
    setSession({ user: { id: fx.userId } });
    expect((await callRevisions(noteId)).status).toBe(404);
  });

  test("returns 401 without a session", async () => {
    const { noteId } = await seedNoteWithHistory("nrev-noauth");
    setSession(null);

    expect((await callRevisions(noteId)).status).toBe(401);
  });

  test("the validator probe 404-shapes HEAD and If-None-Match requests too", async () => {
    const { fx, ctx, noteId } = await seedNoteWithHistory("nrev-probe404");
    const stranger = await seedUserOrgProject("nrev-probe404-x");
    setSession({ user: { id: stranger.userId } });
    expect(
      (await callRevisions(noteId, { "if-none-match": '"0-0-0"' })).status,
    ).toBe(404);

    await deleteNote(ctx, noteId);
    setSession({ user: { id: fx.userId } });
    expect((await callRevisions(noteId, {}, "HEAD")).status).toBe(404);
  });
});

describe("realtime note events: metaChanged flag", () => {
  test("graph-inert writes emit metaChanged false; graph-visible writes true", async () => {
    const fx = await seedUserOrgProject("nev-meta");
    const ctx = makeAuthContext(fx.userId);
    const note = await createNote(ctx, {
      projectId: fx.projectId,
      title: "N",
      visibility: "team",
    });

    const frames: string[] = [];
    broker.attach(fx.userId, {
      send: (data) => frames.push(data),
      close: () => {},
    });
    broker.register(fx.userId, `project:${fx.projectId}`);

    await updateNote(ctx, note.id, { body: "plain prose, no refs" });
    await moveNote(ctx, note.id, "docs");
    await updateNote(ctx, note.id, { title: "Renamed" });

    expect(noteEventsFrom(frames).map((e) => e.metaChanged)).toEqual([
      false,
      true,
      true,
    ]);
  });

  test("a body edit that changes the derived link set emits metaChanged true", async () => {
    const fx = await seedUserOrgProject("nev-meta-derive");
    const ctx = makeAuthContext(fx.userId);
    const su = superuserPool();
    const [task] = await su<{ id: string }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number")
      VALUES (${fx.projectId}, 'T1', 1)
      RETURNING id
    `;
    void task;
    const note = await createNote(ctx, {
      projectId: fx.projectId,
      title: "Source",
      visibility: "team",
    });

    const frames: string[] = [];
    broker.attach(fx.userId, {
      send: (data) => frames.push(data),
      close: () => {},
    });
    broker.register(fx.userId, `project:${fx.projectId}`);

    await updateNote(ctx, note.id, {
      body: `see [[PRJnev-meta-derive-1]]`,
    });

    expect(noteEventsFrom(frames).map((e) => e.metaChanged)).toEqual([true]);
  });
});
