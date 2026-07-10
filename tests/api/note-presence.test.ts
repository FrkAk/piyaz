import { test, expect, afterEach, mock } from "bun:test";
import { nextHeadersMockModule } from "@/tests/setup/next-headers-mock";

/**
 * The presence route's `authorizeWrite` reads the client IP via
 * `next/headers`, which needs a Next request scope; the shared mock
 * (process-wide but stable across files) resolves an empty `Headers`.
 */
mock.module("next/headers", nextHeadersMockModule);

import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { createNote } from "@/lib/data/note";
import { makeAuthContext } from "@/lib/auth/context";
import { getBackend, setBackend } from "@/lib/api/rate-limit";
import { broker } from "@/lib/realtime/broker";
import type { RealtimeEvent } from "@/lib/realtime/types";
import { POST as presencePOST } from "@/app/api/note/[noteId]/presence/route";

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

afterEach(async () => {
  broker._resetForTests();
  await truncateAll();
});

/**
 * Build a presence POST request.
 *
 * @param noteId - Target note id.
 * @param body - JSON body; a string is sent raw (malformed-JSON case).
 * @returns Request targeting the presence route handler.
 */
function post(noteId: string, body: unknown): Request {
  return new Request(`http://test/api/note/${noteId}/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * Invoke the presence route handler.
 *
 * @param noteId - Target note id.
 * @param body - JSON body for the request.
 * @returns The route response.
 */
async function callPresence(noteId: string, body: unknown): Promise<Response> {
  return presencePOST(post(noteId, body), {
    params: Promise.resolve({ noteId }),
  });
}

/**
 * Attach a frame-recording fake connection for a user and subscribe it to
 * the note's channel, so dispatches on `note:<id>` are observable.
 *
 * @param userId - User to attach.
 * @param noteId - Note channel to subscribe.
 * @returns The recorded frames array (mutated on dispatch).
 */
function attachRecorder(userId: string, noteId: string): string[] {
  const frames: string[] = [];
  broker.attach(userId, { send: (data) => frames.push(data), close: () => {} });
  broker.register(userId, `note:${noteId}`);
  return frames;
}

/**
 * Decode the presence payloads out of recorded SSE frames.
 *
 * @param frames - Raw `data: <json>` frames.
 * @returns Parsed realtime events.
 */
function decodeFrames(frames: string[]): RealtimeEvent[] {
  return frames.map(
    (f) => JSON.parse(f.replace(/^data: /, "").trim()) as RealtimeEvent,
  );
}

test("POST /api/note/[id]/presence — 401 unauthenticated", async () => {
  const f = await seedUserOrgProject("presence-401");
  const note = await createNote(makeAuthContext(f.userId), {
    projectId: f.projectId,
    title: "Team note",
    visibility: "team",
  });
  setSession(null);

  const res = await callPresence(note.id, { state: "editing" });
  expect(res.status).toBe(401);
});

test("POST /api/note/[id]/presence — 404 for non-uuid, cross-team, and trashed notes", async () => {
  const f = await seedUserOrgProject("presence-404a");
  const g = await seedUserOrgProject("presence-404b");
  const foreign = await createNote(makeAuthContext(g.userId), {
    projectId: g.projectId,
    title: "Foreign",
    visibility: "team",
  });
  const doomed = await createNote(makeAuthContext(f.userId), {
    projectId: f.projectId,
    title: "Doomed",
    visibility: "team",
  });
  const sql = superuserPool();
  await sql`UPDATE notes SET deleted_at = now() WHERE id = ${doomed.id}`;
  setSession({ user: { id: f.userId } });

  expect((await callPresence("not-a-uuid", { state: "editing" })).status).toBe(
    404,
  );
  expect((await callPresence(foreign.id, { state: "editing" })).status).toBe(
    404,
  );
  expect((await callPresence(doomed.id, { state: "editing" })).status).toBe(
    404,
  );
});

test("POST /api/note/[id]/presence — 400 for malformed or identity-carrying bodies", async () => {
  const f = await seedUserOrgProject("presence-400");
  const note = await createNote(makeAuthContext(f.userId), {
    projectId: f.projectId,
    title: "Team note",
    visibility: "team",
  });
  setSession({ user: { id: f.userId } });

  expect((await callPresence(note.id, "not json")).status).toBe(400);
  expect((await callPresence(note.id, {})).status).toBe(400);
  expect((await callPresence(note.id, { state: "typing" })).status).toBe(400);
  expect(
    (
      await callPresence(note.id, {
        state: "editing",
        userId: "spoofed",
        name: "Spoofed",
      })
    ).status,
  ).toBe(400);
});

test("POST /api/note/[id]/presence — 429 over budget with Retry-After", async () => {
  const f = await seedUserOrgProject("presence-429");
  const note = await createNote(makeAuthContext(f.userId), {
    projectId: f.projectId,
    title: "Team note",
    visibility: "team",
  });
  setSession({ user: { id: f.userId } });

  const previous = getBackend("actions");
  setBackend("actions", {
    check: async () => ({
      allowed: false,
      limit: 30,
      remaining: 0,
      resetIn: 42,
    }),
  });
  try {
    const res = await callPresence(note.id, { state: "editing" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
  } finally {
    setBackend("actions", previous);
  }
});

test("POST /api/note/[id]/presence — team note dispatches session-derived identity on note:<id>", async () => {
  const f = await seedUserOrgProject("presence-team");
  const note = await createNote(makeAuthContext(f.userId), {
    projectId: f.projectId,
    title: "Team note",
    visibility: "team",
  });
  const session = {
    user: { id: f.userId, name: "Session Name", image: "https://a.test/x.png" },
  };
  setSession(session);
  const frames = attachRecorder(f.userId, note.id);

  const editing = await callPresence(note.id, { state: "editing" });
  expect(editing.status).toBe(204);
  const gone = await callPresence(note.id, { state: "gone" });
  expect(gone.status).toBe(204);

  const events = decodeFrames(frames);
  expect(events).toEqual([
    {
      kind: "note-presence",
      noteId: note.id,
      userId: f.userId,
      name: "Session Name",
      image: "https://a.test/x.png",
      state: "editing",
    },
    {
      kind: "note-presence",
      noteId: note.id,
      userId: f.userId,
      name: "Session Name",
      image: "https://a.test/x.png",
      state: "gone",
    },
  ]);
});

test("POST /api/note/[id]/presence — private note returns 204 and dispatches nothing", async () => {
  const f = await seedUserOrgProject("presence-private");
  const note = await createNote(makeAuthContext(f.userId), {
    projectId: f.projectId,
    title: "Private note",
    visibility: "private",
  });
  const ownerSession = {
    user: { id: f.userId, name: "Owner", image: null },
  };
  setSession(ownerSession);
  const frames = attachRecorder(f.userId, note.id);

  const res = await callPresence(note.id, { state: "editing" });
  expect(res.status).toBe(204);
  expect(frames).toEqual([]);
});

test("POST /api/note/[id]/presence — registers note:<id> only for connected callers and only on editing", async () => {
  const f = await seedUserOrgProject("presence-reg");
  const note = await createNote(makeAuthContext(f.userId), {
    projectId: f.projectId,
    title: "Team note",
    visibility: "team",
  });
  const ownerSession = {
    user: { id: f.userId, name: "Owner", image: null },
  };
  setSession(ownerSession);

  await callPresence(note.id, { state: "editing" });
  expect([...broker.subscribers(`note:${note.id}`)]).toEqual([]);

  broker.attach(f.userId, { send: () => {}, close: () => {} });
  await callPresence(note.id, { state: "gone" });
  expect([...broker.subscribers(`note:${note.id}`)]).toEqual([]);

  await callPresence(note.id, { state: "editing" });
  expect([...broker.subscribers(`note:${note.id}`)]).toEqual([f.userId]);
});
