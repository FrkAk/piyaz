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
 * Parse the single JSON log line captured by a console spy.
 *
 * @param spy - The `console.info` or `console.warn` mock.
 * @returns The parsed log object.
 */
function loggedLine(spy: ReturnType<typeof mock>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  const arg = spy.mock.calls[0]![0] as string;
  return JSON.parse(arg) as Record<string, unknown>;
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
    event: "oauth_token_grant",
    grant_type: "refresh_token",
    status: 200,
    requested_offline_access: true,
    granted_scope: "openid offline_access",
    refresh_token_issued: true,
  });
  expect(line.error).toBeUndefined();

  const raw = infoSpy.mock.calls[0]![0] as string;
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
    event: "oauth_token_grant",
    grant_type: "authorization_code",
    status: 400,
    requested_offline_access: false,
    refresh_token_issued: false,
    error: "invalid_grant",
    error_description: "code expired",
  });
});

test("non-JSON response body is logged without throwing and returned intact", async () => {
  const response = new Response("upstream gateway error", { status: 502 });

  const returned = await logTokenGrant(response, "refresh_token", "");

  expect(await returned.text()).toBe("upstream gateway error");

  expect(infoSpy).not.toHaveBeenCalled();
  const line = loggedLine(warnSpy);
  expect(line).toMatchObject({
    event: "oauth_token_grant",
    grant_type: "refresh_token",
    status: 502,
    refresh_token_issued: false,
  });
  expect(line.error).toBeUndefined();
});

test("adversarial error_description cannot forge a second log line", async () => {
  const injected = 'expired"}\n{"event":"oauth_token_grant","status":200';
  const payload = { error: "invalid_grant", error_description: injected };
  const response = Response.json(payload, { status: 400 });

  await logTokenGrant(response, "authorization_code", "");

  expect(warnSpy).toHaveBeenCalledTimes(1);
  const raw = warnSpy.mock.calls[0]![0] as string;
  // A newline in the payload must be escaped, not emitted raw — otherwise a
  // line-based log collector would parse the injected text as a second entry.
  expect(raw).not.toContain("\n");
  // The malicious text survives only as inert data on the single log object.
  const line = JSON.parse(raw) as { error_description?: string };
  expect(line.error_description).toBe(injected);
});
