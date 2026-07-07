import { test, expect } from "bun:test";

/**
 * Source-level guard: the shared Markdown component exposes extension points
 * (extra remark plugins, component overrides, a replacement sanitize schema)
 * while keeping remark-gfm as the base plugin.
 */
test("Markdown exposes extension props and keeps remarkGfm as the base", async () => {
  const src = await Bun.file("components/shared/Markdown.tsx").text();
  expect(src).toContain("remarkPlugins");
  expect(src).toContain("sanitizeSchema");
  expect(src).toContain("remarkGfm, ...");
  expect(src).toMatch(/sanitizeSchema \?\? schema/);
});
