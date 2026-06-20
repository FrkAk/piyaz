import { test, expect, afterEach } from "bun:test";
import {
  GET as authCatchAllGET,
  POST as authCatchAllPOST,
} from "@/app/api/auth/[...all]/route";
import { POST as oauthTokenPOST } from "@/app/api/auth/oauth2/token/route";
import { headerRules } from "@/lib/security/headers";
import { truncateAll } from "@/tests/setup/schema";

/**
 * PYZ-198: pin `Cache-Control: no-store` at every Piyaz-owned auth surface
 * so a shared cache (CDN edge, corporate proxy, browser bfcache) cannot
 * store and replay a session-bearing response to a different user.
 *
 * Two test styles bracket the change, matching `cookie-attributes.test.ts`:
 *   - static `config pin`: assert the `headerRules()` shape for the auth
 *     pages (`/sign-in`, `/sign-up`, `/consent`). Bun cannot exercise the
 *     Next.js header-rules pipeline (`next.config.ts` `headers()` callback),
 *     so the pin is on the config the pipeline consumes — the same approach
 *     `cookie-attributes.test.ts` uses for `revokeSessionsOnPasswordReset`.
 *   - dynamic: drive the catch-all route handler (`app/api/auth/[...all]`)
 *     and the dedicated token route (`app/api/auth/oauth2/token`) with
 *     synthetic `Request`s so the project-owned `no-store` wrapper code path
 *     runs. Calling `auth.handler` directly would skip the wrapper; the
 *     point is to exercise it. Even a 4xx/401 response must carry
 *     `Cache-Control: no-store` because the wrapper applies uniformly.
 *
 * The wrapper deliberately also covers `/jwks` (BA emits no Cache-Control;
 * keys rotate and clients fetch on demand, so eliminating intermediate
 * caching is defense-in-depth). The well-known discovery docs are NOT
 * downgraded: BA tags them `public, max-age=15` before the wrapper runs and
 * the `headers.has('cache-control')` guard lets that pass through. Browser
 * bfcache disqualification is the intended UX of `no-store` on auth pages.
 *
 * `tests/setup/preload.ts` forces `NODE_ENV=production` plus a test-only
 * `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` before any test file loads, so
 * the static imports boot BA correctly regardless of import order.
 *
 * Loopback IP range: this file owns `127.0.3.x` via `cf-connecting-ip`
 * (`lib/auth.ts:117` `ipAddressHeaders`) to keep BA's in-memory rate-limit
 * bucket isolated — it is not reset by `truncateAll`. `cookie-attributes`
 * owns the whole `127.0.0.x`, `rate-limit` owns `127.0.1.x`, and
 * `change-password` owns `127.0.2.x`. Do not reuse these.
 */

const BASE = "https://example.test/api/auth";

afterEach(async () => {
  await truncateAll();
});

test("config pin: headerRules pins a non-cacheable Cache-Control for /sign-in, /sign-up, /consent", () => {
  // AC #1. Pin the static config the Next.js `headers()` pipeline consumes,
  // for both prod and dev — auth pages must not be cached in either. The
  // exact value must match Next's dynamic-render default so the config rule
  // never downgrades it; assert the literal so a regression to bare
  // `no-store` (which drops private/no-cache/must-revalidate) is caught here,
  // since Bun cannot exercise the Next pipeline to check the wire header.
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
  // AC #2. Reaching auth.handler is the point — a bad-credentials 4xx still
  // flows through the wrapper, so the header must be present regardless.
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
  // AC #2.
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
  // AC #2. No session cookie attached; BA returns without a Set-Cookie but
  // the wrapper applies unconditionally.
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
  // AC #2. Unauthenticated get-session returns 200 with a null body and no
  // Cache-Control from BA; the wrapper supplies no-store.
  const response = await authCatchAllGET(
    new Request(`${BASE}/get-session`, {
      method: "GET",
      headers: { "cf-connecting-ip": "127.0.3.43" },
    }),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("/oauth2/token response carries Cache-Control: no-store (BA + wrapper guard)", async () => {
  // AC #3. Drive the dedicated route POST so the ensureNoStore wrapper runs.
  // An invalid grant yields a 4xx; BA sets no-store on it (index.mjs:600)
  // and the wrapper is a no-op-on-write, but either way the header is set.
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
  // AC #3. BA emits no Cache-Control on userinfo; the catch-all wrapper
  // supplies it. A missing/invalid bearer token yields 401 — still wrapped.
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
  // AC #3. introspect takes form-urlencoded client_id + token.
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
  // AC #3. revoke takes form-urlencoded client_id + token.
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

test("well-known discovery doc keeps BA's public cache hint (wrapper does not downgrade)", async () => {
  // AC #3 negative: the well-known route is allowlisted, but BA tags it
  // `public, max-age=15, ...` before the wrapper runs and the
  // headers.has('cache-control') guard must leave that untouched.
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
