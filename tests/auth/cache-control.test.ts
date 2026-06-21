import { test, expect, afterEach } from "bun:test";
import {
  GET as authCatchAllGET,
  POST as authCatchAllPOST,
} from "@/app/api/auth/[...all]/route";
import { POST as oauthTokenPOST } from "@/app/api/auth/oauth2/token/route";
import { headerRules } from "@/lib/security/headers";
import { truncateAll } from "@/tests/setup/schema";

/**
 * PYZ-198: pin `Cache-Control: no-store` on every session-bearing Piyaz auth
 * surface so a shared cache (CDN edge, corporate proxy) cannot store and
 * replay a response to a different user. Public discovery surfaces — the
 * well-known metadata and the `/jwks` keyset — stay cacheable.
 *
 * Two styles bracket the change, matching `cookie-attributes.test.ts`:
 *   - static `config pin`: assert the `headerRules()` shape for the auth pages
 *     (`/sign-in`, `/sign-up`, `/consent`). Bun cannot run the Next.js
 *     `headers()` pipeline, so the pin is on the config it consumes.
 *   - dynamic: drive the catch-all and dedicated token route handlers with
 *     synthetic `Request`s so the project-owned wrapper runs. Even a 4xx/401
 *     must carry `no-store`, since the wrapper applies before returning.
 *
 * `tests/setup/preload.ts` forces `NODE_ENV=production` plus a test-only
 * `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` before any test file loads, so the
 * static imports boot BA correctly regardless of import order.
 *
 * Loopback IP range: this file owns `127.0.3.x` via `cf-connecting-ip` to keep
 * BA's in-memory rate-limit bucket isolated (`truncateAll` does not reset it).
 * `cookie-attributes` owns `127.0.0.x`, `rate-limit` owns `127.0.1.x`,
 * `change-password` owns `127.0.2.x`. Do not reuse these.
 */

const BASE = "https://example.test/api/auth";

afterEach(async () => {
  await truncateAll();
});

test("config pin: headerRules pins a non-cacheable Cache-Control for /sign-in, /sign-up, /consent", () => {
  const expected = "private, no-cache, no-store, max-age=0, must-revalidate";
  for (const isProd of [false, true]) {
    const rules = headerRules(isProd);
    for (const source of ["/sign-in", "/sign-up", "/consent"]) {
      const rule = rules.find(
        (r) =>
          r.source === source &&
          r.headers.some(
            (h) => h.key === "Cache-Control" && h.value === expected,
          ),
      );
      expect(rule, `${source} (isProd=${isProd})`).toBeDefined();
    }
  }
});

test("BA core /sign-in/email response carries Cache-Control: no-store via the catch-all wrapper", async () => {
  const response = await authCatchAllPOST(
    new Request(`${BASE}/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "127.0.3.40",
      },
      body: JSON.stringify({
        email: "no-such-user@test.local",
        password: "x",
      }),
    }),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("BA core /sign-up/email response carries Cache-Control: no-store", async () => {
  const response = await authCatchAllPOST(
    new Request(`${BASE}/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "127.0.3.41",
      },
      body: JSON.stringify({
        email: "cache-signup@test.local",
        name: "Cache Signup",
        password: "test-password-12345",
      }),
    }),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("BA core /sign-out response carries Cache-Control: no-store", async () => {
  const response = await authCatchAllPOST(
    new Request(`${BASE}/sign-out`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "127.0.3.42",
      },
    }),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("BA core /get-session response carries Cache-Control: no-store", async () => {
  const response = await authCatchAllGET(
    new Request(`${BASE}/get-session`, {
      method: "GET",
      headers: { "cf-connecting-ip": "127.0.3.43" },
    }),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("/oauth2/token error response carries Cache-Control: no-store (wrapper-supplied)", async () => {
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const response = await oauthTokenPOST(
    new Request(`${BASE}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "127.0.3.44",
      },
      body: body.toString(),
    }),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("/oauth2/userinfo response carries Cache-Control: no-store (wrapper-supplied)", async () => {
  const response = await authCatchAllGET(
    new Request(`${BASE}/oauth2/userinfo`, {
      method: "GET",
      headers: {
        authorization: "Bearer invalid-token",
        "cf-connecting-ip": "127.0.3.45",
      },
    }),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("/oauth2/introspect response carries Cache-Control: no-store (wrapper-supplied)", async () => {
  const response = await authCatchAllPOST(
    new Request(`${BASE}/oauth2/introspect`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "127.0.3.46",
      },
      body: new URLSearchParams({
        client_id: "no-such-client",
        token: "no-such-token",
      }).toString(),
    }),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("/oauth2/revoke response carries Cache-Control: no-store (wrapper-supplied)", async () => {
  const response = await authCatchAllPOST(
    new Request(`${BASE}/oauth2/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "127.0.3.47",
      },
      body: new URLSearchParams({
        client_id: "no-such-client",
        token: "no-such-token",
      }).toString(),
    }),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("well-known oauth-authorization-server keeps BA's public cache hint (wrapper does not downgrade)", async () => {
  const response = await authCatchAllGET(
    new Request(`${BASE}/.well-known/oauth-authorization-server`, {
      method: "GET",
      headers: { "cf-connecting-ip": "127.0.3.48" },
    }),
  );
  const cacheControl = response.headers.get("cache-control");
  expect(cacheControl).toContain("public");
  expect(cacheControl).not.toContain("no-store");
});

test("/jwks keyset stays cacheable (wrapper sets a public hint, not no-store)", async () => {
  const response = await authCatchAllGET(
    new Request(`${BASE}/jwks`, {
      method: "GET",
      headers: { "cf-connecting-ip": "127.0.3.49" },
    }),
  );
  const cacheControl = response.headers.get("cache-control");
  expect(cacheControl).toContain("public");
  expect(cacheControl).not.toContain("no-store");
});

test("well-known openid-configuration keeps BA's public cache hint (wrapper does not downgrade)", async () => {
  const response = await authCatchAllGET(
    new Request(`${BASE}/.well-known/openid-configuration`, {
      method: "GET",
      headers: { "cf-connecting-ip": "127.0.3.50" },
    }),
  );
  const cacheControl = response.headers.get("cache-control");
  expect(cacheControl).toContain("public");
  expect(cacheControl).not.toContain("no-store");
});
