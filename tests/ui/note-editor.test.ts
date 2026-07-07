import { test, expect } from "bun:test";

/**
 * Source-level guards for the whole-note editor: renders through
 * NoteMarkdown, enters edit on double-click, edits in a textarea, exits on
 * Escape, and gates editing on `editable`.
 */
test("NoteEditor renders NoteMarkdown and uses the shared inline-edit affordances", async () => {
  const src = await Bun.file(
    "components/workspace/notes/NoteEditor.tsx",
  ).text();
  expect(src).toContain("NoteMarkdown");
  expect(src).toContain("useInlineEdit");
  expect(src).toContain("EditHint");
  expect(src).toContain("EditButton");
  expect(src).toContain("AutoGrowTextarea");
  expect(src).toMatch(/key === "Escape"/);
  expect(src).toContain("editable");
});

test("wiki autocomplete reuses the shared ranker", async () => {
  const src = await Bun.file(
    "components/workspace/notes/useWikiAutocomplete.tsx",
  ).text();
  expect(src).toContain("rankLinkSuggestions");
});
