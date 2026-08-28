import { expect, mock, test } from "bun:test";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import { deriveDpopAth } from "better-auth/oauth2";

/**
 * Transport-boundary tests for `app/api/mcp/route.ts`: the 401 gate for
 * missing/invalid bearers and the 413 body cap. JWT verification is mocked
 * (`better-auth/oauth2` + the kid probe) so the cap check is reachable
 * without minting real tokens; everything below the boundary is covered by
 * `tests/mcp/server.test.ts` and the handler suites.
 */

const FAKE_SUB = "11111111-1111-4111-8111-111111111111";

const realOauth2 = await import("better-auth/oauth2");

mock.module("better-auth/oauth2", () => ({
  ...realOauth2,
  verifyJwsAccessToken: async (token: string) =>
    JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    ) as JWTPayload,
}));

// A JWS-shaped bearer whose protected header carries a `kid`, so the route's
// real `hasKid` probe passes without mocking `@/lib/mcp/verify`. A module mock
// there leaks process-wide and clobbers `hasKid` for other test files.
function bearer(payload: JWTPayload): string {
  return `${Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "test" })).toString(
    "base64url",
  )}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

const KID_BEARER = bearer({ sub: FAKE_SUB, azp: "test-client" });

const route = await import("@/app/api/mcp/route");

/**
 * Build a POST request against the MCP route.
 *
 * @param headers - Request headers.
 * @param body - JSON body string.
 * @returns The Request.
 */
function mcpRequest(headers: Record<string, string>, body = "{}"): Request {
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

/**
 * Create a DPoP-bound access token and its matching proof.
 *
 * @returns Bound access token and signed proof JWT.
 */
async function dpopAuthorization(): Promise<{ token: string; proof: string }> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(jwk);
  const token = bearer({ sub: FAKE_SUB, azp: "test-client", cnf: { jkt } });
  const proof = await new SignJWT({
    ath: await deriveDpopAth(token),
    htm: "POST",
    htu: "http://localhost:3000/api/mcp",
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
    .setIssuedAt()
    .sign(privateKey);
  return { token, proof };
}

test("POST without a bearer returns 401 with resource metadata", async () => {
  const res = await route.POST(mcpRequest({}));
  expect(res.status).toBe(401);
  expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
});

test("POST with a non-bearer authorization returns 401", async () => {
  const res = await route.POST(mcpRequest({ authorization: "Basic abc" }));
  expect(res.status).toBe(401);
});

test("POST rejects bearer replay of a DPoP-bound access token", async () => {
  const token = bearer({
    sub: FAKE_SUB,
    azp: "test-client",
    cnf: { jkt: "bound-key-thumbprint" },
  });
  const res = await route.POST(
    mcpRequest({ authorization: `Bearer ${token}` }),
  );
  expect(res.status).toBe(401);
});

test("POST accepts one valid DPoP proof and rejects its replay", async () => {
  const { token, proof } = await dpopAuthorization();
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: `DPoP ${token}`,
    dpop: proof,
  };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  const first = await route.POST(mcpRequest(headers, body));
  expect(first.status).toBe(200);

  const replay = await route.POST(mcpRequest(headers, body));
  expect(replay.status).toBe(401);
});

test("POST atomically rejects a concurrent DPoP proof replay", async () => {
  const { token, proof } = await dpopAuthorization();
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: `DPoP ${token}`,
    dpop: proof,
  };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  const responses = await Promise.all([
    route.POST(mcpRequest(headers, body)),
    route.POST(mcpRequest(headers, body)),
  ]);

  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 401,
  ]);
});

test("POST over the body cap returns the MCP-shaped 413", async () => {
  const res = await route.POST(
    mcpRequest({
      authorization: `Bearer ${KID_BEARER}`,
      "content-length": String(100 * 1024 * 1024),
    }),
  );
  expect(res.status).toBe(413);
  const body = (await res.json()) as { error: { message: string } };
  expect(body.error.message).toContain("too large");
});

test("GET returns 405 with the POST-only allow list", async () => {
  const res = route.GET();
  expect(res.status).toBe(405);
  expect(res.headers.get("Allow")).toBe("POST, DELETE");
});

test("DELETE is a stateless no-op 204", () => {
  expect(route.DELETE().status).toBe(204);
});
