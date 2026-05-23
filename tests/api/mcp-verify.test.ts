import { test, expect } from "bun:test";
import {
  JWTExpired,
  JWTInvalid,
  JWTClaimValidationFailed,
  JWSInvalid,
  JWSSignatureVerificationFailed,
  JWKSNoMatchingKey,
} from "jose/errors";
import { classifyVerifyError, hasKid } from "@/lib/mcp/verify";

/**
 * Encode a JSON object as base64url for hand-crafted JWT headers.
 *
 * @param obj - Object to encode.
 * @returns Base64url string with no padding.
 */
function base64UrlJson(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Hand-craft a JWS-shaped string `header.payload.signature` with the given
 * protected header. The signature is a placeholder — `hasKid` only inspects
 * the header.
 *
 * @param header - Decoded protected header.
 * @returns Three-part dotted token.
 */
function makeToken(header: Record<string, unknown>): string {
  return `${base64UrlJson(header)}.${base64UrlJson({ sub: "u" })}.sig`;
}

test("classifyVerifyError: JWTExpired is token-class", () => {
  expect(classifyVerifyError(new JWTExpired("expired", {}))).toBe("token");
});

test("classifyVerifyError: JWTInvalid is token-class", () => {
  expect(classifyVerifyError(new JWTInvalid("bad"))).toBe("token");
});

test("classifyVerifyError: JWTClaimValidationFailed is token-class", () => {
  expect(classifyVerifyError(new JWTClaimValidationFailed("aud", {}))).toBe(
    "token",
  );
});

test("classifyVerifyError: JWSInvalid is token-class", () => {
  expect(classifyVerifyError(new JWSInvalid("bad jws"))).toBe("token");
});

test("classifyVerifyError: JWSSignatureVerificationFailed is token-class", () => {
  expect(classifyVerifyError(new JWSSignatureVerificationFailed())).toBe(
    "token",
  );
});

test("classifyVerifyError: JWKSNoMatchingKey is token-class", () => {
  expect(classifyVerifyError(new JWKSNoMatchingKey())).toBe("token");
});

test("classifyVerifyError: plain Error without code is infrastructure", () => {
  expect(
    classifyVerifyError(
      new Error("auth.api.getJwks returned unexpected shape"),
    ),
  ).toBe("infrastructure");
});

test("classifyVerifyError: Error with unknown code is infrastructure", () => {
  const err = Object.assign(new Error("nope"), { code: "ERR_OTHER" });
  expect(classifyVerifyError(err)).toBe("infrastructure");
});

test("classifyVerifyError: non-Error throwable is infrastructure", () => {
  expect(classifyVerifyError("string thrown")).toBe("infrastructure");
  expect(classifyVerifyError(null)).toBe("infrastructure");
  expect(classifyVerifyError({ code: "ERR_JWT_EXPIRED" })).toBe(
    "infrastructure",
  );
});

test("hasKid: token with kid in protected header returns true", () => {
  expect(hasKid(makeToken({ alg: "EdDSA", kid: "key-1" }))).toBe(true);
});

test("hasKid: token without kid returns false", () => {
  expect(hasKid(makeToken({ alg: "EdDSA" }))).toBe(false);
});

test("hasKid: token with empty-string kid returns false", () => {
  expect(hasKid(makeToken({ alg: "EdDSA", kid: "" }))).toBe(false);
});

test("hasKid: malformed token returns false without throwing", () => {
  expect(hasKid("not.a.jwt")).toBe(false);
  expect(hasKid("only-one-part")).toBe(false);
  expect(hasKid("")).toBe(false);
});
