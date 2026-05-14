import { test, expect } from "bun:test";

/**
 * Static guard: the rendered `<a>` in LinksSection must carry
 * `target="_blank"` and `rel="noopener noreferrer"`. Without these, an
 * external link could (a) replace the current tab and (b) reverse-tabnab
 * via `window.opener` back into the workspace surface. The source-level
 * assertion catches drift without requiring a DOM test runner.
 */
test("LinksSection anchor opens in a new tab with noopener/noreferrer", async () => {
  const src = await Bun.file(
    "components/workspace/detail/LinksSection.tsx",
  ).text();

  expect(src).toContain('href={link.url}');
  expect(src).toContain('target="_blank"');
  expect(src).toContain('rel="noopener noreferrer"');
});
