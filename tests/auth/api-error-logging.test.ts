import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { logAuthApiError } from "@/lib/auth/api-error-log";
import { auth } from "@/lib/auth";

/**
 * `logAuthApiError` replaces Better Auth's default router error logging
 * (`better-auth/dist/api/index.mjs` `onError`), which serializes caught
 * errors message-only and discards the stack — leaving production 500s
 * like `/api/auth/get-session` "No request state found" undiagnosable.
 * The hook receives the raw error from better-call's router catch, so
 * the structured log must surface every stack the object carries:
 * `errorStack` (better-call APIError hides `stack` via
 * `Error.stackTraceLimit = 0` at construction), plain `stack`, and the
 * `cause` chain.
 */

const spies: Array<{ mockRestore: () => void }> = [];

/**
 * Spy on `console.error`, suppressing output and tracking the spy for
 * restoration after each test.
 *
 * @returns The installed spy.
 */
function spyConsoleError() {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  spies.push(spy);
  return spy;
}

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/**
 * Parse the single JSON-string argument of the spy's only call.
 *
 * @param spy - The `console.error` spy after exactly one expected call.
 * @returns The structured log payload.
 */
function loggedPayload(spy: ReturnType<typeof spyConsoleError>) {
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
}

describe("logAuthApiError", () => {
  it("is wired as Better Auth's onAPIError handler", () => {
    expect(auth.options.onAPIError?.onError).toBe(logAuthApiError);
  });

  it("logs status, message, and hidden errorStack for 500 APIErrors", () => {
    const spy = spyConsoleError();
    const inner = new Error("No request state found.");
    const apiError = Object.assign(
      new Error("Error: No request state found."),
      {
        name: "APIError",
        status: "INTERNAL_SERVER_ERROR",
        statusCode: 500,
        errorStack:
          "APIError: hidden frames\n    at routerCatch (router.mjs:1:1)",
        body: { message: "Error: No request state found.", cause: inner },
      },
    );

    logAuthApiError(apiError);

    const payload = loggedPayload(spy);
    expect(payload.event).toBe("better_auth_api_error");
    expect(payload.status).toBe("INTERNAL_SERVER_ERROR");
    expect(payload.statusCode).toBe(500);
    expect(payload.message).toBe("Error: No request state found.");
    expect(payload.stack).toContain("routerCatch");
    const causes = payload.causes as Array<Record<string, unknown>>;
    expect(causes[0].message).toBe("No request state found.");
    expect(causes[0].stack).toContain("api-error-logging.test.ts");
  });

  it("logs plain errors with their own stack and walks nested causes", () => {
    const spy = spyConsoleError();
    const root = new Error("socket severed");
    const mid = new Error("query failed", { cause: root });
    const top = new Error("request state lost", { cause: mid });

    logAuthApiError(top);

    const payload = loggedPayload(spy);
    expect(payload.message).toBe("request state lost");
    expect(payload.stack).toContain("api-error-logging.test.ts");
    const causes = payload.causes as Array<Record<string, unknown>>;
    expect(causes.map((c) => c.message)).toEqual([
      "query failed",
      "socket severed",
    ]);
  });

  it("stays silent for non-5xx APIErrors", () => {
    const spy = spyConsoleError();
    const unauthorized = Object.assign(new Error("unauthorized"), {
      status: "UNAUTHORIZED",
      statusCode: 401,
    });

    logAuthApiError(unauthorized);

    expect(spy).not.toHaveBeenCalled();
  });

  it("survives cyclic cause chains", () => {
    const spy = spyConsoleError();
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;

    logAuthApiError(new Error("top", { cause: a }));

    const payload = loggedPayload(spy);
    const causes = payload.causes as Array<Record<string, unknown>>;
    expect(causes.map((c) => c.message)).toEqual(["a", "b"]);
  });

  it("redacts emails and constraint values from every logged field", () => {
    const spy = spyConsoleError();
    const dbCause = new Error(
      "duplicate key value violates unique constraint: Key (email)=(person@example.com) already exists",
    );
    const top = new Error("insert failed for person@example.com", {
      cause: dbCause,
    });

    logAuthApiError(top);

    const raw = spy.mock.calls[0][0] as string;
    expect(raw).not.toContain("person@example.com");
    const payload = JSON.parse(raw) as Record<string, unknown>;
    expect(payload.message).toContain("[email]");
    const causes = payload.causes as Array<Record<string, unknown>>;
    expect(causes[0].message).toContain("(email)=([redacted])");
  });

  it("caps oversized stacks and messages", () => {
    const spy = spyConsoleError();
    const noisy = new Error("m".repeat(2_000));
    noisy.stack = `Error: x\n${"    at frame (file.ts:1:1)\n".repeat(500)}`;

    logAuthApiError(noisy);

    const payload = loggedPayload(spy);
    expect((payload.message as string).length).toBeLessThanOrEqual(500);
    expect((payload.stack as string).length).toBeLessThanOrEqual(4_000);
  });
});
