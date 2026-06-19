import { test, expect } from "bun:test";
import { evaluateRedirect, safeLinkHost } from "@/lib/auth/safe-redirect";

test("evaluateRedirect: null URI fails closed with (missing)", () => {
  const result = evaluateRedirect(null, "piyaz.com");
  expect(result.safe).toBe(false);
  expect(result.display).toBe("(missing)");
});

test("evaluateRedirect: unparseable URI fails closed and echoes raw input", () => {
  const result = evaluateRedirect("not a url", "piyaz.com");
  expect(result.safe).toBe(false);
  expect(result.display).toBe("not a url");
});

test("evaluateRedirect: vscode:// scheme is trusted", () => {
  const result = evaluateRedirect("vscode://mcp-callback?code=abc", null);
  expect(result.safe).toBe(true);
  expect(result.display).toBe("vscode://mcp-callback?code=abc");
});

test("evaluateRedirect: cursor:// scheme is trusted", () => {
  expect(evaluateRedirect("cursor://callback", null).safe).toBe(true);
});

test("evaluateRedirect: claude:// scheme is trusted", () => {
  expect(evaluateRedirect("claude://oauth/return", null).safe).toBe(true);
});

test("evaluateRedirect: http://localhost on any port is trusted", () => {
  const result = evaluateRedirect("http://localhost:54321/cb", null);
  expect(result.safe).toBe(true);
  expect(result.display).toBe("localhost:54321");
});

test("evaluateRedirect: http://127.0.0.1 is trusted", () => {
  const result = evaluateRedirect("http://127.0.0.1/cb", null);
  expect(result.safe).toBe(true);
  expect(result.display).toBe("127.0.0.1");
});

test("evaluateRedirect: http://[::1] is trusted", () => {
  expect(evaluateRedirect("http://[::1]:3000/cb", null).safe).toBe(true);
});

test("evaluateRedirect: same-host redirect is trusted when ownHost is set", () => {
  const result = evaluateRedirect("https://piyaz.com/cb", "piyaz.com");
  expect(result.safe).toBe(true);
  expect(result.display).toBe("piyaz.com");
});

test("evaluateRedirect: same-host redirect with non-default port matches host including port", () => {
  expect(
    evaluateRedirect("https://piyaz.com:8443/cb", "piyaz.com:8443").safe,
  ).toBe(true);
});

test("evaluateRedirect: same-host with ownHost null (SSR) fails closed", () => {
  const result = evaluateRedirect("https://piyaz.com/cb", null);
  expect(result.safe).toBe(false);
  expect(result.display).toBe("piyaz.com");
});

test("evaluateRedirect: cross-origin https redirect is unsafe", () => {
  const result = evaluateRedirect("https://attacker.com/cb", "piyaz.com");
  expect(result.safe).toBe(false);
  expect(result.display).toBe("attacker.com");
});

test("evaluateRedirect: lookalike hostname does not match localhost via substring", () => {
  const result = evaluateRedirect("http://localhost.evil.com/cb", null);
  expect(result.safe).toBe(false);
  expect(result.display).toBe("localhost.evil.com");
});

test("evaluateRedirect: hostname prefix attack on 127.0.0.1 does not match", () => {
  const result = evaluateRedirect("http://127.0.0.1.evil.com/cb", null);
  expect(result.safe).toBe(false);
  expect(result.display).toBe("127.0.0.1.evil.com");
});

test("safeLinkHost: returns host for https URL", () => {
  expect(safeLinkHost("https://claude.com/legal")).toBe("claude.com");
});

test("safeLinkHost: returns host with port", () => {
  expect(safeLinkHost("https://example.com:8443/page")).toBe(
    "example.com:8443",
  );
});

test("safeLinkHost: returns null for unparseable URL", () => {
  expect(safeLinkHost("not-a-url")).toBeNull();
});

test("safeLinkHost: returns null for javascript: scheme", () => {
  expect(safeLinkHost("javascript:alert(1)")).toBeNull();
});

test("safeLinkHost: returns null for data: scheme", () => {
  expect(safeLinkHost("data:text/html,<script>x</script>")).toBeNull();
});

test("safeLinkHost: returns null for vscode: scheme (not a web link)", () => {
  expect(safeLinkHost("vscode://callback")).toBeNull();
});
