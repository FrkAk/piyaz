import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { extractNoteRefs } from "@/lib/data/note-parse";
import { createNote, getNoteFull, updateNote } from "@/lib/data/note";
import { createTask } from "@/lib/data/task";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

test("extractNoteRefs parses refs and wiki links outside code", () => {
  const refs = extractNoteRefs("see PRJ1-12 and [[Data model]]", "PRJ1");
  expect(refs.taskSeqs).toEqual([12]);
  expect(refs.titles).toEqual(["Data model"]);
});

test("extractNoteRefs skips inline code spans and bold runs", () => {
  expect(extractNoteRefs("inline `PRJ1-12` here", "PRJ1").taskSeqs).toEqual([]);
  expect(extractNoteRefs("also `[[Nope]]` here", "PRJ1").titles).toEqual([]);
  expect(extractNoteRefs("bold **PRJ1-12** run", "PRJ1").taskSeqs).toEqual([]);
});

test("extractNoteRefs skips fenced code blocks", () => {
  const body = "before\n```\nPRJ1-12 and [[Hidden]]\n```\nafter PRJ1-3";
  const refs = extractNoteRefs(body, "PRJ1");
  expect(refs.taskSeqs).toEqual([3]);
  expect(refs.titles).toEqual([]);
});

test("extractNoteRefs matches case-insensitively and dedupes", () => {
  const refs = extractNoteRefs("prj1-12 PRJ1-12 [[Model]] [[model]]", "PRJ1");
  expect(refs.taskSeqs).toEqual([12]);
  expect(refs.titles).toEqual(["Model"]);
});

test("extractNoteRefs escapes identifier metacharacters", () => {
  expect(extractNoteRefs("A.B-3", "A.B").taskSeqs).toEqual([3]);
  expect(extractNoteRefs("AXB-3", "A.B").taskSeqs).toEqual([]);
  expect(extractNoteRefs("[[  ]] [[real]]", "PRJ1").titles).toEqual(["real"]);
});

test("body writes derive task mentions and note links", async () => {
  const f = await seedUserOrgProject("lnk1");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await createNote(ctx, { projectId: f.projectId, title: "Data model" });

  const source = await createNote(ctx, {
    projectId: f.projectId,
    title: "Source",
    body: `see ${task.taskRef} and [[Data model]]`,
  });

  const full = await getNoteFull(ctx, source.id);
  expect(full.mentions.length).toBe(1);
  expect(full.mentions[0].taskRef).toBe(task.taskRef);
  expect(full.mentions[0].kind).toBe("mention");
  expect(full.linksOut.length).toBe(1);
  expect(full.linksOut[0].title).toBe("Data model");
});

test("re-derivation replaces mention rows but preserves user-managed kinds", async () => {
  const f = await seedUserOrgProject("lnk2");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await createNote(ctx, { projectId: f.projectId, title: "Target" });
  const source = await createNote(ctx, {
    projectId: f.projectId,
    title: "Source",
    body: `refs ${task.taskRef} and [[Target]]`,
  });

  const sr = serviceRoleConnect();
  await sr`
    INSERT INTO note_task_links (note_id, task_id, kind)
    VALUES (${source.id}, ${task.id}, 'reference')`;

  await updateNote(ctx, source.id, { body: "no refs anymore" });

  const links = await sr<{ kind: string }[]>`
    SELECT kind FROM note_task_links WHERE note_id = ${source.id}`;
  expect(links.map((l) => l.kind)).toEqual(["reference"]);
  const noteLinks = await sr<{ id: string }[]>`
    SELECT id FROM note_links WHERE source_note_id = ${source.id}`;
  expect(noteLinks.length).toBe(0);
});

test("broken refs and self links are never stored", async () => {
  const f = await seedUserOrgProject("lnk3");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "Self",
    body: "see PRJlnk3-999 and [[Nope]] and [[Self]]",
  });

  const sr = serviceRoleConnect();
  const taskLinks = await sr<{ id: string }[]>`
    SELECT id FROM note_task_links WHERE note_id = ${note.id}`;
  const noteLinks = await sr<{ id: string }[]>`
    SELECT id FROM note_links WHERE source_note_id = ${note.id}`;
  expect(taskLinks.length).toBe(0);
  expect(noteLinks.length).toBe(0);
});

test("retitling a target note keeps existing links and affects only future derivations", async () => {
  const f = await seedUserOrgProject("lnk4");
  const ctx = makeAuthContext(f.userId);
  const target = await createNote(ctx, {
    projectId: f.projectId,
    title: "Old name",
  });
  const source = await createNote(ctx, {
    projectId: f.projectId,
    title: "Source",
    body: "see [[Old name]]",
  });

  await updateNote(ctx, target.id, { title: "New name" });
  const full = await getNoteFull(ctx, source.id);
  expect(full.linksOut.length).toBe(1);
  expect(full.linksOut[0].id).toBe(target.id);

  await updateNote(ctx, source.id, { body: "see [[Old name]] again" });
  const rederived = await getNoteFull(ctx, source.id);
  expect(rederived.linksOut.length).toBe(0);
});
