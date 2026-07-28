import { test, expect } from "bun:test";
import { POST as tokenPost } from "@/app/api/auth/oauth2/token/route";

/**
 * Attack-path coverage for request body ceilings.
 *
 * Both routes buffer their body before anything validates it, against an
 * isolate whose memory ceiling is shared by every concurrent request. A body
 * that is legal at the platform edge can still exceed that ceiling once a
 * handler holds several copies of it, so the cap belongs in the handler.
 */

/**
 * Build a form-encoded token request carrying a body of the given size.
 *
 * @param bytes - Payload size in bytes.
 * @param withContentLength - Whether to declare `content-length`.
 * @returns The request to hand to the route.
 */
function oversizedTokenRequest(
  bytes: number,
  withContentLength: boolean,
): Request {
  const body = `grant_type=authorization_code&code=${"a".repeat(bytes)}`;
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (withContentLength) headers["content-length"] = String(body.length);
  return new Request("https://example.test/api/auth/oauth2/token", {
    method: "POST",
    headers,
    body,
  });
}

test("attack: an oversized token body is refused with 413", async () => {
  const response = await tokenPost(oversizedTokenRequest(64 * 1024, true));
  expect(response.status).toBe(413);
});

test("attack: a declared content-length cannot be used to smuggle a large body", async () => {
  const response = await tokenPost(oversizedTokenRequest(64 * 1024, false));
  expect(response.status).toBe(413);
});

test("a normal token request is not refused by the cap", async () => {
  const response = await tokenPost(oversizedTokenRequest(16, true));
  expect(response.status).not.toBe(413);
});
