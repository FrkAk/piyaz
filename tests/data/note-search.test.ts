import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import {
  createNote,
  deleteNote,
  getNoteTreeList,
  searchNotes,
  NoteValidationError,
} from "@/lib/data/note";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

test("searchNotes matches body and title words with ranked hits", async () => {
  const f = await seedUserOrgProject("srch1");
  const ctx = makeAuthContext(f.userId);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Session rotation",
    body: "Refresh tokens rotate on every request.",
  });
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Unrelated",
    body: "Nothing to see here.",
  });

  const byBody = await searchNotes(ctx, f.projectId, "refresh tokens");
  expect(byBody.length).toBe(1);
  expect(byBody[0].title).toBe("Session rotation");

  const byTitle = await searchNotes(ctx, f.projectId, "rotation");
  expect(byTitle.length).toBe(1);
});

test("searchNotes is project-scoped and excludes trashed notes", async () => {
  const f1 = await seedUserOrgProject("srch2a");
  const f2 = await seedUserOrgProject("srch2b");
  const ctx1 = makeAuthContext(f1.userId);
  const ctx2 = makeAuthContext(f2.userId);
  await createNote(ctx2, {
    projectId: f2.projectId,
    title: "Elsewhere",
    body: "pelican architecture",
  });
  const mine = await createNote(ctx1, {
    projectId: f1.projectId,
    title: "Here",
    body: "pelican architecture",
  });

  expect((await searchNotes(ctx1, f1.projectId, "pelican")).length).toBe(1);

  await deleteNote(ctx1, mine.id);
  expect((await searchNotes(ctx1, f1.projectId, "pelican")).length).toBe(0);
});

test("searchNotes handles quoted phrases and stopword-only queries", async () => {
  const f = await seedUserOrgProject("srch3");
  const ctx = makeAuthContext(f.userId);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Adjacent",
    body: "alpha beta gamma",
  });
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Split",
    body: "alpha gamma beta",
  });

  const phrase = await searchNotes(ctx, f.projectId, '"alpha beta"');
  expect(phrase.map((h) => h.title)).toEqual(["Adjacent"]);

  expect(await searchNotes(ctx, f.projectId, "the and of")).toEqual([]);
  expect(await searchNotes(ctx, f.projectId, "   ")).toEqual([]);
  await expect(
    searchNotes(ctx, f.projectId, "x".repeat(300)),
  ).rejects.toBeInstanceOf(NoteValidationError);
});

test("pure-negation queries match nothing", async () => {
  const f = await seedUserOrgProject("srch6");
  const ctx = makeAuthContext(f.userId);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Doc",
    body: "walrus content",
  });

  expect(await searchNotes(ctx, f.projectId, "-draft")).toEqual([]);
  expect((await searchNotes(ctx, f.projectId, "walrus -draft")).length).toBe(1);
});

test("search caps hits at 20", async () => {
  const f = await seedUserOrgProject("srch4");
  const ctx = makeAuthContext(f.userId);
  for (let i = 0; i < 25; i++) {
    await createNote(ctx, {
      projectId: f.projectId,
      title: `Doc ${i}`,
      body: "shared keyword walrus",
    });
  }
  const hits = await searchNotes(ctx, f.projectId, "walrus");
  expect(hits.length).toBe(20);
});

test("searchNotes prefix-matches the last term for type-ahead", async () => {
  const f = await seedUserOrgProject("srch7");
  const ctx = makeAuthContext(f.userId);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Authorization guide",
    body: "How authorization decisions are made.",
  });
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Unrelated",
    body: "Nothing to see here.",
  });

  const hits = await searchNotes(ctx, f.projectId, "auth");
  expect(hits.map((h) => h.title)).toEqual(["Authorization guide"]);
});

test("searchNotes multi-word type-ahead still requires the head terms", async () => {
  const f = await seedUserOrgProject("srch8");
  const ctx = makeAuthContext(f.userId);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Both",
    body: "note linking behavior",
  });
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Missing head",
    body: "linking only here",
  });

  const hits = await searchNotes(ctx, f.projectId, "note lin");
  expect(hits.map((h) => h.title)).toEqual(["Both"]);
});

test("searchNotes skips the prefix arm for closed phrases and short last terms", async () => {
  const f = await seedUserOrgProject("srch9");
  const ctx = makeAuthContext(f.userId);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Doc",
    body: "walrus content",
  });

  expect(await searchNotes(ctx, f.projectId, '"walrus co"')).toEqual([]);
  expect(await searchNotes(ctx, f.projectId, "w")).toEqual([]);
  expect(await searchNotes(ctx, f.projectId, "walrus x")).toEqual([]);
});

test("searchNotes stays safe on tsquery syntax in the input", async () => {
  const f = await seedUserOrgProject("srch10");
  const ctx = makeAuthContext(f.userId);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Doc",
    body: "walrus content",
  });

  const sanitized = await searchNotes(ctx, f.projectId, "walrus & walr:*");
  expect(sanitized.map((h) => h.title)).toEqual(["Doc"]);

  const hostile = await searchNotes(
    ctx,
    f.projectId,
    "walr:*'); DROP TABLE notes;--",
  );
  expect(Array.isArray(hostile)).toBe(true);
});

test("tree list and search hits stay slim: no body, no search_tsv", async () => {
  const f = await seedUserOrgProject("srch5");
  const ctx = makeAuthContext(f.userId);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Slim",
    body: "egress discipline",
    folder: "a",
  });

  const [treeRow] = await getNoteTreeList(ctx, f.projectId);
  expect(Object.keys(treeRow).sort()).toEqual(
    [
      "agentWritable",
      "feedMode",
      "folder",
      "id",
      "locked",
      "sequenceNumber",
      "slug",
      "summary",
      "title",
      "type",
      "updatedAt",
      "visibility",
    ].sort(),
  );

  const [hit] = await searchNotes(ctx, f.projectId, "egress");
  expect("body" in hit).toBe(false);
  expect("searchTsv" in hit).toBe(false);
  expect("snippet" in hit).toBe(false);
  expect("rank" in hit).toBe(false);
});
