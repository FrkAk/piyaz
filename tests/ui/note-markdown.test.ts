import { test, expect } from "bun:test";

/**
 * Source-level guards: NoteMarkdown composes the shared renderer with the
 * ref plugin, an extended sanitize schema, and the chip/link components,
 * and the chip/link components are exported for reuse.
 */
test("NoteMarkdown wires the ref plugin, schema, and chip/link components", async () => {
  const src = await Bun.file(
    "components/workspace/notes/NoteMarkdown.tsx",
  ).text();
  expect(src).toContain("remarkNoteRefs");
  expect(src).toContain('"noteref-task"');
  expect(src).toContain('"noteref-note"');
  expect(src).toContain('"noteref-wiki"');
  expect(src).toContain("sanitizeSchema");
  expect(src).toMatch(/TaskChip/);
  expect(src).toMatch(/NoteRefLink/);
  expect(src).toMatch(/DocLink/);
});

test("TaskChip, NoteRefLink, and DocLink are exported for reuse", async () => {
  const src = await Bun.file(
    "components/workspace/notes/NoteInline.tsx",
  ).text();
  expect(src).toMatch(/export function TaskChip/);
  expect(src).toMatch(/export function NoteRefLink/);
  expect(src).toMatch(/export function DocLink/);
});
