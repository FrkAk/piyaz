import { test, expect } from "bun:test";

/**
 * Source-level guards for the whole-note editor: renders through
 * NoteMarkdown, enters edit on double-click, edits in a textarea, exits on
 * Escape, and gates editing on `editable`.
 */
test("NoteEditor renders NoteMarkdown with hint, pencil, and line-aware double-click", async () => {
  const src = await Bun.file(
    "components/workspace/notes/NoteEditor.tsx",
  ).text();
  expect(src).toContain("NoteMarkdown");
  expect(src).toContain("EditHint");
  expect(src).toContain("EditButton");
  expect(src).toContain("onDoubleClick");
  expect(src).toContain("data-src-line");
  expect(src).toContain("AutoGrowTextarea");
  expect(src).toMatch(/key === "Escape"/);
  expect(src).toContain("editable");
});

test("EditorPane reconciles the title through the pure predicates and a dirty ref", async () => {
  const src = await Bun.file(
    "components/workspace/notes/EditorPane.tsx",
  ).text();
  expect(src).toContain("shouldAdoptServerTitle");
  expect(src).toContain("shouldCommitTitle");
  expect(src).toContain("shouldClearDirty");
  expect(src).toMatch(/const \[dirty, setDirty\] = useState/);
  expect(src).toContain("setDirty(true)");
  expect(src).not.toContain("if (title === null && note !== undefined)");
  expect(src).not.toContain("title === note.title");
});

test("wiki autocomplete reuses the shared ranker", async () => {
  const src = await Bun.file(
    "components/workspace/notes/useWikiAutocomplete.tsx",
  ).text();
  expect(src).toContain("rankLinkSuggestions");
});
