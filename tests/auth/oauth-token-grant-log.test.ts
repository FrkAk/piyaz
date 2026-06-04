import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { logTokenGrant } from "@/lib/auth/log-token-grant";

/**
 * Unit coverage for the token-grant logger (#108, MYMR-225). Pins two
 * invariants: the clone-don't-consume contract — `logTokenGrant` reads a
 * clone and returns the original response body intact — and the
 * no-secrets contract — the emitted line carries grant metadata but never
 * token values.
 */

const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
let infoSpy: ReturnType<typeof mock>;
let warnSpy: ReturnType<typeof mock>;

beforeEach(() => {
  infoSpy = mock(() => {});
  warnSpy = mock(() => {});
  console.info = infoSpy;
  console.warn = warnSpy;
});

afterEach(() => {
  console.info = originalConsoleInfo;
  console.warn = originalConsoleWarn;
});

/**
 * Read the structured context object from the single console call captured
 * by a spy, asserting the `oauth_token_grant` message tag.
 *
 * @param spy - The `console.info` or `console.warn` mock.
 * @returns The logged context object.
 */
function loggedLine(spy: ReturnType<typeof mock>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  const [message, context] = spy.mock.calls[0]! as [
    string,
    Record<string, unknown>,
  ];
  expect(message).toBe("oauth_token_grant");
  return context;
}

test("successful refresh-token grant logs refresh_token_issued and returns body intact", async () => {
  const payload = {
    access_token: "secret-access-token-value",
    refresh_token: "secret-refresh-token-value",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid offline_access",
  };
  const response = Response.json(payload, { status: 200 });

  const returned = await logTokenGrant(
    response,
    "refresh_token",
    "openid offline_access",
  );

  expect(await returned.json()).toEqual(payload);

  expect(warnSpy).not.toHaveBeenCalled();
  const line = loggedLine(infoSpy);
  expect(line).toMatchObject({
    grant_type: "refresh_token",
    status: 200,
    requested_scope: "openid offline_access",
    granted_scope: "openid offline_access",
    refresh_token_issued: true,
  });
  expect(line.error).toBeUndefined();

  const raw = JSON.stringify(infoSpy.mock.calls[0]);
  expect(raw).not.toContain(payload.access_token);
  expect(raw).not.toContain(payload.refresh_token);
});

test("failed grant logs the error via console.warn and returns body intact", async () => {
  const payload = { error: "invalid_grant", error_description: "code expired" };
  const response = Response.json(payload, { status: 400 });

  const returned = await logTokenGrant(response, "authorization_code", "");

  expect(await returned.json()).toEqual(payload);

  expect(infoSpy).not.toHaveBeenCalled();
  const line = loggedLine(warnSpy);
  expect(line).toMatchObject({
    grant_type: "authorization_code",
    status: 400,
    refresh_token_issued: false,
    error: "invalid_grant",
    error_description: "code expired",
  });
  expect(line.requested_scope).toBeUndefined();
});

test("non-JSON response body is logged without throwing and returned intact", async () => {
  const response = new Response("upstream gateway error", { status: 502 });

  const returned = await logTokenGrant(response, "refresh_token", "");

  expect(await returned.text()).toBe("upstream gateway error");

  expect(infoSpy).not.toHaveBeenCalled();
  const line = loggedLine(warnSpy);
  expect(line).toMatchObject({
    grant_type: "refresh_token",
    status: 502,
    refresh_token_issued: false,
  });
  expect(line.error).toBeUndefined();
});

test("adversarial error_description is carried as inert data, not structure", async () => {
  const injected = 'expired"}\n{"event":"oauth_token_grant","status":200';
  const payload = { error: "invalid_grant", error_description: injected };
  const response = Response.json(payload, { status: 400 });

  await logTokenGrant(response, "authorization_code", "");

  // The crafted text — including its newline and braces — lands as a single
  // inert string field on the structured context object. It cannot break out
  // of that object to forge a second log record; the runtime serializer
  // escapes the value just as it does for every other structured log.
  const line = loggedLine(warnSpy) as { error_description?: string };
  expect(line.error_description).toBe(injected);
});
