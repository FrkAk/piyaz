import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { internalError } from "@/lib/api/error";

const originalNodeEnv = process.env.NODE_ENV;
const originalConsoleError = console.error;
let consoleSpy: ReturnType<typeof mock>;

function setNodeEnv(value: string | undefined): void {
  Object.defineProperty(process.env, "NODE_ENV", {
    value,
    configurable: true,
  });
}

beforeEach(() => {
  consoleSpy = mock(() => {});
  console.error = consoleSpy;
});

afterEach(() => {
  setNodeEnv(originalNodeEnv);
  console.error = originalConsoleError;
});

test("development NODE_ENV forwards the raw message — local debug aid", async () => {
  setNodeEnv("development");
  const err = new Error("Failed query: detailed cause");
  const res = internalError("graph", err);

  expect(res.status).toBe(500);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("Failed query: detailed cause");
});

test("production NODE_ENV returns generic 'Internal error' body and never leaks the cause", async () => {
  // Regression: PR #65's routes echoed `err.message` from drizzle's
  // 'Failed query' verbatim, which carries the SQL plus bound params
  // (including the authenticated user's id). The production response
  // body must not include any substring from a leaked drizzle error.
  setNodeEnv("production");
  const err = new Error(
    "Failed query: SELECT * FROM users WHERE user_id = 'abac41e5-uuid-leak'\nparams: abac41e5-uuid-leak",
  );
  const res = internalError("projects", err);

  expect(res.status).toBe(500);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("Internal error");
  expect(body.error).not.toContain("Failed query");
  expect(body.error).not.toContain("SELECT");
  expect(body.error).not.toContain("abac41e5");
  expect(body.error).not.toContain("params");
});

test("production NODE_ENV logs the original error so server-side debugging stays possible", async () => {
  setNodeEnv("production");
  const err = new Error("real cause for the log");
  internalError("task-context", err);

  expect(consoleSpy).toHaveBeenCalledTimes(1);
  const call = consoleSpy.mock.calls[0]!;
  expect(call[0]).toBe("[task-context] error:");
  expect(call[1]).toBe(err);
});

test("test NODE_ENV stays generic — only development is verbose", async () => {
  setNodeEnv("test");
  const err = new Error("test-mode message must not leak");
  const res = internalError("projects", err);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("Internal error");
});

test("unknown NODE_ENV (e.g. 'staging', typos, undefined) stays generic — fail-safe default", async () => {
  // Whitelist guard: anything other than the literal `"development"` —
  // including future Next.js renames or operator typos — must NOT enable
  // verbose mode. Defending against silent value changes.
  for (const value of ["staging", "DEVELOPMENT", "dev", "production ", undefined]) {
    setNodeEnv(value);
    const res = internalError(
      "projects",
      new Error("must-not-leak in mode=" + String(value)),
    );
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Internal error");
  }
});

test("non-Error thrown values produce a generic response even in development", async () => {
  setNodeEnv("development");
  const res = internalError("task", "some-string-thrown");
  expect(res.status).toBe(500);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("Internal error");

  expect(consoleSpy).toHaveBeenCalledTimes(1);
  const call = consoleSpy.mock.calls[0]!;
  expect(call[0]).toBe("[task] error:");
  expect(call[1]).toBe("some-string-thrown");
});
