import { test, expect, afterEach } from "bun:test";
import { isVerifiedOAuthClient } from "@/lib/auth/verified-oauth-clients";

const ENV_KEY = "MYMIR_VERIFIED_OAUTH_CLIENT_IDS";
const originalValue = process.env[ENV_KEY];

afterEach(() => {
  if (originalValue === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalValue;
});

test("no client is verified when the allowlist is unset", () => {
  // Safe default: with open dynamic registration there are no pre-trusted
  // clients, so nothing may receive brand polish.
  delete process.env[ENV_KEY];
  expect(isVerifiedOAuthClient("any-client-id")).toBe(false);
});

test("matches exact ids from the comma-separated allowlist", () => {
  process.env[ENV_KEY] = "id-one, id-two ,id-three";
  expect(isVerifiedOAuthClient("id-one")).toBe(true);
  expect(isVerifiedOAuthClient("id-two")).toBe(true);
  expect(isVerifiedOAuthClient("id-three")).toBe(true);
  expect(isVerifiedOAuthClient("id-four")).toBe(false);
});

test("blank allowlist entries never match", () => {
  process.env[ENV_KEY] = " , ,";
  expect(isVerifiedOAuthClient("")).toBe(false);
  expect(isVerifiedOAuthClient(" ")).toBe(false);
});

test("the memoized set re-keys when the env value changes", () => {
  process.env[ENV_KEY] = "first-id";
  expect(isVerifiedOAuthClient("first-id")).toBe(true);
  process.env[ENV_KEY] = "second-id";
  expect(isVerifiedOAuthClient("first-id")).toBe(false);
  expect(isVerifiedOAuthClient("second-id")).toBe(true);
});
