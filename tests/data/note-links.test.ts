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
  const refs = extractNoteRefs("see [[PRJ1-12]] and [[Data model]]", "PRJ1");
  expect(refs.taskSeqs).toEqual([12]);
  expect(refs.titles).toEqual(["Data model"]);
});

test("extractNoteRefs skips inline code spans", () => {
  expect(extractNoteRefs("inline `[[PRJ1-12]]` here", "PRJ1").taskSeqs).toEqual(
    [],
  );
  expect(extractNoteRefs("also `[[Nope]]` here", "PRJ1").titles).toEqual([]);
});

test("extractNoteRefs links refs inside bold runs", () => {
  expect(extractNoteRefs("bold **[[PRJ1-12]]** run", "PRJ1").taskSeqs).toEqual([
    12,
  ]);
  expect(extractNoteRefs("bold **[[Model]]** run", "PRJ1").titles).toEqual([
    "Model",
  ]);
});

test("extractNoteRefs skips fenced code blocks", () => {
  const body = "before\n```\n[[PRJ1-12]] and [[Hidden]]\n```\nafter [[PRJ1-3]]";
  const refs = extractNoteRefs(body, "PRJ1");
  expect(refs.taskSeqs).toEqual([3]);
  expect(refs.titles).toEqual([]);
});

test("extractNoteRefs follows CommonMark fence rules", () => {
  const nested = "````\n```\n[[PRJ1-9]]\n```\n````\nafter [[PRJ1-2]]";
  expect(extractNoteRefs(nested, "PRJ1").taskSeqs).toEqual([2]);

  const unterminated = "```[[PRJ1-5]]\n[[PRJ1-6]] swallowed";
  expect(extractNoteRefs(unterminated, "PRJ1").taskSeqs).toEqual([]);

  const tilde = "~~~\n[[PRJ1-7]]\n~~~\nafter [[PRJ1-8]]";
  expect(extractNoteRefs(tilde, "PRJ1").taskSeqs).toEqual([8]);

  const indented = "  ```\n[[PRJ1-4]]\n```\nafter [[PRJ1-1]]";
  expect(extractNoteRefs(indented, "PRJ1").taskSeqs).toEqual([1]);

  const shortCloser = "````\n[[PRJ1-3]]\n```\n[[PRJ1-5]]\n````\nout [[PRJ1-6]]";
  expect(extractNoteRefs(shortCloser, "PRJ1").taskSeqs).toEqual([6]);

  const backtickInfo = "```code`span`\n[[PRJ1-12]] after";
  expect(extractNoteRefs(backtickInfo, "PRJ1").taskSeqs).toEqual([12]);
});

test("extractNoteRefs matches case-insensitively and dedupes", () => {
  const refs = extractNoteRefs(
    "[[prj1-12]] [[PRJ1-12]] [[Model]] [[model]]",
    "PRJ1",
  );
  expect(refs.taskSeqs).toEqual([12]);
  expect(refs.titles).toEqual(["Model"]);
});

test("extractNoteRefs escapes identifier metacharacters", () => {
  expect(extractNoteRefs("[[A.B-3]]", "A.B").taskSeqs).toEqual([3]);
  expect(extractNoteRefs("[[AXB-3]]", "A.B").taskSeqs).toEqual([]);
  expect(extractNoteRefs("[[  ]] [[real]]", "PRJ1").titles).toEqual(["real"]);
});

test("extractNoteRefs classifies note refs by the N segment, disjoint from tasks", () => {
  const refs = extractNoteRefs(
    "[[PRJ1-12]] [[PRJ1-N7]] [[prj1-n7]] [[Title]]",
    "PRJ1",
  );
  expect(refs.taskSeqs).toEqual([12]);
  expect(refs.noteSeqs).toEqual([7]);
  expect(refs.titles).toEqual(["Title"]);
});

test("extractNoteRefs treats a note ref for another identifier as a title", () => {
  const refs = extractNoteRefs("[[OTHER-N7]]", "PRJ1");
  expect(refs.noteSeqs).toEqual([]);
  expect(refs.titles).toEqual(["OTHER-N7"]);
});

test("body writes derive task mentions and note links", async () => {
  const f = await seedUserOrgProject("lnk1");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await createNote(ctx, { projectId: f.projectId, title: "Data model" });

  const source = await createNote(ctx, {
    projectId: f.projectId,
    title: "Source",
    body: `see [[${task.taskRef}]] and [[Data model]]`,
  });

  const full = await getNoteFull(ctx, source.id);
  expect(full.mentions.length).toBe(1);
  expect(full.mentions[0].taskRef).toBe(task.taskRef);
  expect(full.mentions[0].kind).toBe("mention");
  expect(full.linksOut.length).toBe(1);
  expect(full.linksOut[0].title).toBe("Data model");
});

test("body-changing updateNote returns re-derived links; metadata patches do not", async () => {
  const f = await seedUserOrgProject("lnk5");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await createNote(ctx, { projectId: f.projectId, title: "Data model" });
  const source = await createNote(ctx, {
    projectId: f.projectId,
    title: "Source",
  });

  const bodyWrite = await updateNote(ctx, source.id, {
    body: `see [[${task.taskRef}]] and [[Data model]]`,
  });
  expect(bodyWrite.links).toBeDefined();
  expect(bodyWrite.links!.mentions.length).toBe(1);
  expect(bodyWrite.links!.mentions[0].taskRef).toBe(task.taskRef);
  expect(bodyWrite.links!.mentions[0].kind).toBe("mention");
  expect(bodyWrite.links!.linksOut.length).toBe(1);
  expect(bodyWrite.links!.linksOut[0].title).toBe("Data model");

  const metaWrite = await updateNote(ctx, source.id, { category: "docs" });
  expect(metaWrite.links).toBeUndefined();
});

test("re-derivation replaces mention rows but preserves user-managed kinds", async () => {
  const f = await seedUserOrgProject("lnk2");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await createNote(ctx, { projectId: f.projectId, title: "Target" });
  const source = await createNote(ctx, {
    projectId: f.projectId,
    title: "Source",
    body: `refs [[${task.taskRef}]] and [[Target]]`,
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

test("a body save with an unchanged link set leaves derived rows untouched", async () => {
  const f = await seedUserOrgProject("lnk6");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await createNote(ctx, { projectId: f.projectId, title: "Target" });
  const source = await createNote(ctx, {
    projectId: f.projectId,
    title: "Source",
    body: `refs [[${task.taskRef}]] and [[Target]]`,
  });

  const sr = serviceRoleConnect();
  const beforeMentions = await sr<{ id: string }[]>`
    SELECT id FROM note_task_links WHERE note_id = ${source.id} ORDER BY id`;
  const beforeLinks = await sr<{ id: string }[]>`
    SELECT id FROM note_links WHERE source_note_id = ${source.id} ORDER BY id`;

  await updateNote(ctx, source.id, {
    body: `reworded, still refs [[${task.taskRef}]] and [[Target]]`,
  });

  const afterMentions = await sr<{ id: string }[]>`
    SELECT id FROM note_task_links WHERE note_id = ${source.id} ORDER BY id`;
  const afterLinks = await sr<{ id: string }[]>`
    SELECT id FROM note_links WHERE source_note_id = ${source.id} ORDER BY id`;
  expect(afterMentions).toEqual(beforeMentions);
  expect(afterLinks).toEqual(beforeLinks);
});

test("broken refs and self links are never stored", async () => {
  const f = await seedUserOrgProject("lnk3");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "Self",
    body: "see [[PRJlnk3-999]] and [[Nope]] and [[Self]]",
  });

  const sr = serviceRoleConnect();
  const taskLinks = await sr<{ id: string }[]>`
    SELECT id FROM note_task_links WHERE note_id = ${note.id}`;
  const noteLinks = await sr<{ id: string }[]>`
    SELECT id FROM note_links WHERE source_note_id = ${note.id}`;
  expect(taskLinks.length).toBe(0);
  expect(noteLinks.length).toBe(0);
});

test("a title link is best-effort: a stale row survives a rename, then clears on the next save", async () => {
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

test("a note-ref link survives the target's rename and the source's next save", async () => {
  const f = await seedUserOrgProject("lnk7");
  const ctx = makeAuthContext(f.userId);
  const target = await createNote(ctx, {
    projectId: f.projectId,
    title: "Old name",
  });
  const targetFull = await getNoteFull(ctx, target.id);
  const ref = `${targetFull.projectIdentifier}-N${targetFull.note.sequenceNumber}`;

  const source = await createNote(ctx, {
    projectId: f.projectId,
    title: "Source",
    body: `see [[${ref}]]`,
  });
  const initial = await getNoteFull(ctx, source.id);
  expect(initial.linksOut.length).toBe(1);
  expect(initial.linksOut[0].id).toBe(target.id);

  await updateNote(ctx, target.id, { title: "New name" });
  const afterRename = await getNoteFull(ctx, source.id);
  expect(afterRename.linksOut.length).toBe(1);
  expect(afterRename.linksOut[0].id).toBe(target.id);

  await updateNote(ctx, source.id, { body: `see [[${ref}]] still` });
  const afterSave = await getNoteFull(ctx, source.id);
  expect(afterSave.linksOut.length).toBe(1);
  expect(afterSave.linksOut[0].id).toBe(target.id);
});

test("a title link and a note-ref link to the same note collapse to one row", async () => {
  const f = await seedUserOrgProject("lnk8");
  const ctx = makeAuthContext(f.userId);
  const target = await createNote(ctx, {
    projectId: f.projectId,
    title: "Data model",
  });
  const targetFull = await getNoteFull(ctx, target.id);
  const ref = `${targetFull.projectIdentifier}-N${targetFull.note.sequenceNumber}`;

  const source = await createNote(ctx, {
    projectId: f.projectId,
    title: "Source",
    body: `[[Data model]] and [[${ref}]]`,
  });

  const sr = serviceRoleConnect();
  const rows = await sr<{ id: string }[]>`
    SELECT id FROM note_links WHERE source_note_id = ${source.id}`;
  expect(rows.length).toBe(1);
  const full = await getNoteFull(ctx, source.id);
  expect(full.linksOut.length).toBe(1);
  expect(full.linksOut[0].id).toBe(target.id);
});
