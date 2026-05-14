import { test, expect } from "bun:test";
import { classifyLink, MalformedLinkError } from "@/lib/links/classify";

test("classifies a GitHub pull request URL", () => {
  const result = classifyLink("https://github.com/anthropic/claude/pull/42");
  expect(result.kind).toBe("pull_request");
  expect(result.label).toBe("anthropic/claude#42");
  expect(result.host).toBe("github.com");
  expect(result.owner).toBe("anthropic");
  expect(result.repo).toBe("claude");
  expect(result.number).toBe(42);
});

test("classifies a GitHub issue URL", () => {
  const result = classifyLink("https://github.com/mymir-dev/mymir/issues/87");
  expect(result.kind).toBe("issue");
  expect(result.label).toBe("mymir-dev/mymir#87");
  expect(result.number).toBe(87);
});

test("classifies a GitHub commit URL and shortens SHA", () => {
  const result = classifyLink(
    "https://github.com/mymir-dev/mymir/commit/abc123def456789",
  );
  expect(result.kind).toBe("commit");
  expect(result.label).toBe("mymir-dev/mymir@abc123d");
});

test("classifies a GitLab merge request URL", () => {
  const result = classifyLink(
    "https://gitlab.com/owner/repo/-/merge_requests/7",
  );
  expect(result.kind).toBe("pull_request");
  expect(result.label).toBe("owner/repo!7");
  expect(result.number).toBe(7);
});

test("classifies a GitLab issue URL", () => {
  const result = classifyLink("https://gitlab.com/owner/repo/-/issues/3");
  expect(result.kind).toBe("issue");
  expect(result.number).toBe(3);
});

test("classifies a Linear issue URL", () => {
  const result = classifyLink(
    "https://linear.app/myws/issue/MYM-42/some-slug",
  );
  expect(result.kind).toBe("issue");
  expect(result.label).toBe("MYM-42");
  expect(result.host).toBe("linear.app");
});

test("classifies a Notion doc URL", () => {
  const result = classifyLink("https://www.notion.so/Some-doc-abc123");
  expect(result.kind).toBe("doc");
  expect(result.host).toBe("notion.so");
});

test("classifies a Figma doc URL", () => {
  const result = classifyLink("https://www.figma.com/file/abc/My-design");
  expect(result.kind).toBe("doc");
  expect(result.host).toBe("figma.com");
});

test("falls back to link kind for arbitrary URLs", () => {
  const result = classifyLink("https://example.com/some/path");
  expect(result.kind).toBe("link");
  expect(result.label).toBe("example.com/some/path");
  expect(result.host).toBe("example.com");
});

test("throws MalformedLinkError on bad input", () => {
  expect(() => classifyLink("not a url")).toThrow(MalformedLinkError);
});

test("throws MalformedLinkError on javascript: URLs (XSS-in-href guard)", () => {
  expect(() => classifyLink("javascript:alert(1)")).toThrow(MalformedLinkError);
  expect(() => classifyLink("JavaScript:alert(1)")).toThrow(MalformedLinkError);
});

test("throws MalformedLinkError on data: URLs (XSS-in-href guard)", () => {
  expect(() =>
    classifyLink("data:text/html,<script>alert(1)</script>"),
  ).toThrow(MalformedLinkError);
});

test("throws MalformedLinkError on file: URLs (local-resource guard)", () => {
  expect(() => classifyLink("file:///etc/passwd")).toThrow(MalformedLinkError);
});

test("accepts http: and https: URLs", () => {
  expect(classifyLink("http://example.com/a").host).toBe("example.com");
  expect(classifyLink("https://example.com/a").host).toBe("example.com");
});

test("normalizes scheme-less input to https://", () => {
  const result = classifyLink("github.com/anthropic/claude/pull/42");
  expect(result.kind).toBe("pull_request");
  expect(result.url).toBe("https://github.com/anthropic/claude/pull/42");
  expect(result.host).toBe("github.com");
});

test("normalizes www-prefixed scheme-less input", () => {
  const result = classifyLink("www.example.com/page");
  expect(result.url).toBe("https://www.example.com/page");
  expect(result.host).toBe("example.com");
});

test("normalizes protocol-relative input (//host/path)", () => {
  const result = classifyLink("//github.com/owner/repo");
  expect(result.url).toBe("https://github.com/owner/repo");
  expect(result.host).toBe("github.com");
});

test("trims whitespace around scheme-less input", () => {
  const result = classifyLink("  github.com/owner/repo/issues/5  ");
  expect(result.kind).toBe("issue");
  expect(result.url).toBe("https://github.com/owner/repo/issues/5");
});

test("preserves a user-supplied https:// scheme verbatim", () => {
  const result = classifyLink("https://github.com/o/r/pull/1");
  expect(result.url).toBe("https://github.com/o/r/pull/1");
});

test("strips www prefix from host", () => {
  const result = classifyLink("https://www.example.com/page");
  expect(result.host).toBe("example.com");
});

test("falls back to link kind for unknown GitHub paths", () => {
  const result = classifyLink("https://github.com/anthropic/claude");
  expect(result.kind).toBe("link");
});
