import { test, expect } from "bun:test";

/**
 * Source-level guards for the whole-note editor: renders through
 * NoteMarkdown, enters edit on double-click, edits in a textarea, exits on
 * Escape, and gates editing on `editable`.
 */
test("NoteEditor renders NoteMarkdown and enters edit on double-click", async () => {
  const src = await Bun.file(
    "components/workspace/notes/NoteEditor.tsx",
  ).text();
  expect(src).toContain("NoteMarkdown");
  expect(src).toContain("onDoubleClick");
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
