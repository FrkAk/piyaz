import { test, expect } from "bun:test";
import { resolveLang } from "@/lib/ui/highlighter";

test("passes canonical supported grammars through unchanged", () => {
  for (const lang of ["typescript", "rust", "python", "json", "cpp"])
    expect(resolveLang(lang)).toBe(lang);
});

test("resolves fence-language aliases to their canonical grammar", () => {
  const cases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    rs: "rust",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    yml: "yaml",
    md: "markdown",
    "c++": "cpp",
  };
  for (const [alias, canonical] of Object.entries(cases))
    expect(resolveLang(alias)).toBe(canonical);
});

test("resolves case-insensitively", () => {
  expect(resolveLang("TypeScript")).toBe("typescript");
  expect(resolveLang("JS")).toBe("javascript");
  expect(resolveLang("C++")).toBe("cpp");
});

test("returns null for unknown languages", () => {
  for (const lang of ["brainfuck", "", "perl"])
    expect(resolveLang(lang)).toBeNull();
});

test("returns null for injection-shaped lang strings", () => {
  for (const lang of [
    "<script>",
    "javascript:",
    "'; DROP TABLE",
    'js" onload="alert(1)',
  ])
    expect(resolveLang(lang)).toBeNull();
});

test("CodeBlock renders tokens as color-only spans and a plain pre/code fallback", async () => {
  const src = await Bun.file("components/shared/CodeBlock.tsx").text();
  expect(src).toContain("style={{ color: token.color }}");
  expect(src).toMatch(/if \(lines === null\)/);
  expect(src).toMatch(/<pre>\s*<code>\{code\}<\/code>\s*<\/pre>/);
  expect(src).not.toContain("dangerouslySetInnerHTML");
});
