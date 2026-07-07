import { test, expect } from "bun:test";

/**
 * Every source file on a note-body render path. A raw-HTML vector on any of
 * these would let untrusted note content reach the DOM as markup.
 */
const RENDER_PATH_FILES = [
  ...new Bun.Glob("components/workspace/notes/*.tsx").scanSync("."),
  "components/shared/Markdown.tsx",
  "components/shared/CodeBlock.tsx",
  "lib/ui/highlighter.ts",
];

/** Raw-HTML escape hatches that must never appear on a note render path. */
const FORBIDDEN = [
  "dangerouslySetInnerHTML",
  "rehype-raw",
  "rehypeRaw",
  "allowDangerousHtml",
  "skipHtml={false}",
];

test.each(
  RENDER_PATH_FILES,
)("%s introduces no raw-HTML rendering vector", async (path) => {
  const src = await Bun.file(path).text();
  for (const needle of FORBIDDEN) expect(src).not.toContain(needle);
});

test("the guard actually covers the note render-path files", () => {
  expect(RENDER_PATH_FILES).toContain(
    "components/workspace/notes/NoteMarkdown.tsx",
  );
  expect(RENDER_PATH_FILES).toContain(
    "components/workspace/notes/NoteEditor.tsx",
  );
  expect(RENDER_PATH_FILES.length).toBeGreaterThan(3);
});

test("NoteEditor routes both non-empty branches through NoteMarkdown only", async () => {
  const src = await Bun.file(
    "components/workspace/notes/NoteEditor.tsx",
  ).text();
  const renders = src.match(/<NoteMarkdown\b/g) ?? [];
  expect(renders).toHaveLength(2);
  expect(src).toContain('import { NoteMarkdown } from "./NoteMarkdown"');
  expect(src).not.toContain("react-markdown");
  expect(src).not.toMatch(/from "@\/components\/shared\/Markdown"/);
});

test("NoteMarkdown routes through the shared sanitized Markdown", async () => {
  const src = await Bun.file(
    "components/workspace/notes/NoteMarkdown.tsx",
  ).text();
  expect(src).toContain(
    'import { Markdown } from "@/components/shared/Markdown"',
  );
  expect(src).toContain("sanitizeSchema={noteSchema}");
  expect(src).toContain("...defaultSchema");
});

test("shared Markdown wires rehype-sanitize and forces safe external anchors", async () => {
  const src = await Bun.file("components/shared/Markdown.tsx").text();
  expect(src).toContain("rehypeSanitize");
  expect(src).toMatch(/sanitizeSchema \?\? schema/);
  expect(src).toContain("...defaultSchema");
  expect(src).toMatch(/EXTERNAL_URL\s*=\s*\/\^https\?:/);
  expect(src).toContain('target="_blank"');
  expect(src).toContain('rel="noopener noreferrer"');
  expect(src).toMatch(/EXTERNAL_URL\.test\(href\)/);
});
