import { auth } from "@/lib/auth";
import { applyIssAdvertisementCompat } from "@/lib/auth/oauth-metadata-compat";
import {
  AUTH_BASE_PATH,
  PUBLIC_CACHEABLE_AUTH_PATHS,
} from "@/lib/auth/public-cache-paths";
import { ensureCacheControl, ensureNoStore } from "@/lib/security/headers";
import { stampClientIpHeader } from "@/lib/security/client-ip";
import { getMcpResource } from "@/lib/auth/oauth-resource";

/**
 * Allowlist of Better Auth HTTP paths (post-`/api/auth` basePath form,
 * trailing slashes stripped to mirror `normalizePathname` at
 * `@better-auth/core/dist/utils/url.mjs:18-29`). Everything else 404s
 * before reaching `auth.handler`, so new routes shipped by a future BA
 * upgrade are default-denied until they are deliberately added here.
 *
 * The `organization/*` family is intentionally absent: every org / team
 * / invitation flow already routes through server actions calling
 * `auth.api.*` directly (see `lib/actions/team-invitations.ts:84` for
 * the pattern), so removing its HTTP exposure closes both the
 * `list-invitations` non-admin bypass (MYMR-155) and the sibling
 * `get-full-organization` leak that returns the same invitation rows
 * to any org member. The password-reset / email-verification / delete
 * confirmation family is exposed for the emailed links and the auth UI;
 * `/change-email` and `/delete-user` stay omitted — both initiate through
 * server actions only (`changeEmailAction`, `deleteAccountAction`), which
 * carry their own rate limits and, for email change, the current-password
 * re-entry gate.
 *
 * `/oauth2/token` is also served by a dedicated Next route
 * (`app/api/auth/oauth2/token/route.ts`) that defaults the `resource`
 * parameter for MCP clients. Next routes the more-specific path to
 * that file; listing `/oauth2/token` here keeps the catch-all
 * functional if the dedicated handler is ever removed.
 */
const ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/email",
  "/sign-up/email",
  "/sign-out",
  "/get-session",

  // Email flows (PYZ-317). The GET entries are emailed links; the POST
  // entries are called by the auth UI (PYZ-318). Rate limits live in
  // `rateLimit.customRules` (lib/auth.ts).
  "/request-password-reset",
  "/reset-password",
  "/verify-email",
  "/send-verification-email",
  "/delete-user/callback",

  // `app/api/mcp/route.ts:36` verifies bearer tokens against this JWKS.
  "/jwks",

  // OAuth provider role (external MCP clients). Client-management
  // endpoints (`/oauth2/create-client` etc.), consent CRUD, and
  // `end-session` are intentionally omitted.
  "/oauth2/authorize",
  "/oauth2/token",
  "/oauth2/consent",
  "/oauth2/continue",
  "/oauth2/register",
  "/oauth2/userinfo",
  "/oauth2/introspect",
  "/oauth2/revoke",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
]);

/**
 * Allowlisted path prefixes for Better Auth routes carrying a path-segment
 * parameter, which the exact-match set cannot express. The only entry is the
 * emailed password-reset link (`/reset-password/<token>`), a GET that
 * redirects to the reset form.
 */
const ALLOWED_PREFIXES: readonly string[] = ["/reset-password/"];

const BASE_PATH = AUTH_BASE_PATH;

/**
 * Allowlisted paths whose responses are public and carry no session or user
 * data, from the shared `lib/auth/public-cache-paths.ts` set the middleware
 * also reads to withhold RateLimit headers. These stay cacheable; every other
 * allowlisted path is session-bearing and pinned to `no-store`. Better Auth
 * already tags the discovery docs with its own public hint, so
 * `JWKS_CACHE_CONTROL` only ever applies to `/jwks`, which Better Auth
 * leaves header-less.
 */
const PUBLIC_CACHEABLE_PATHS = PUBLIC_CACHEABLE_AUTH_PATHS;

/**
 * Public Cache-Control for the JWKS keyset. The keys are public and gain
 * nothing from `no-store`, so the endpoint stays cacheable — the same posture
 * Better Auth gives the sibling discovery metadata. The short max-age keeps
 * HTTP-layer caches (browser, proxy) propagating key rotation quickly; it does
 * not bind jose's `createRemoteJWKSet`, which ignores HTTP Cache-Control and
 * refreshes on its own timers / on an unknown `kid`. Better Auth keeps retired
 * keys valid for a 30-day grace period.
 */
const JWKS_CACHE_CONTROL =
  "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400";

/**
 * Discovery documents Better Auth serves under the basePath. Their bodies pass
 * through `applyIssAdvertisementCompat` so MCP clients see the same document
 * here as on the root-level `/.well-known/oauth-authorization-server` route,
 * keeping every discovery surface consistent. See
 * `lib/auth/oauth-metadata-compat.ts` for the rationale.
 */
const DISCOVERY_METADATA_PATHS: ReadonlySet<string> = new Set([
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
]);

/**
 * Normalize a request pathname to its post-basePath, trailing-slash-stripped
 * form, or `null` when the path is outside `/api/auth`.
 *
 * @param pathname - Request pathname.
 * @returns Normalized Better Auth path (e.g. `/jwks`), or `null` if not under
 *   the basePath.
 */
function normalizeAuthPath(pathname: string): string | null {
  if (pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) {
    return null;
  }
  const stripped =
    pathname === BASE_PATH ? "/" : pathname.slice(BASE_PATH.length);
  return stripped.replace(/\/+$/, "") || "/";
}

/**
 * Rebuild an allowlisted auth request and default the MCP resource on OAuth
 * authorization requests that omit it.
 *
 * @param request - Incoming auth request.
 * @param path - Normalized Better Auth path.
 * @param headers - Sanitized and client-address-stamped request headers.
 * @returns A bounded request suitable for Better Auth's handler.
 */
async function buildForwardedRequest(
  request: Request,
  path: string,
  headers: Headers,
): Promise<Request> {
  const url = new URL(request.url);
  let body: BodyInit | null =
    request.body === null ? null : await request.arrayBuffer();

  if (path === "/oauth2/authorize") {
    if (request.method === "GET" && !url.searchParams.has("resource")) {
      url.searchParams.set("resource", getMcpResource());
    } else if (
      request.method === "POST" &&
      headers
        .get("content-type")
        ?.toLowerCase()
        ?.includes("application/x-www-form-urlencoded") &&
      body instanceof ArrayBuffer
    ) {
      const params = new URLSearchParams(new TextDecoder().decode(body));
      if (!params.has("resource")) {
        params.set("resource", getMcpResource());
        body = params.toString();
      }
    }
  }

  return new Request(url.href, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
  });
}

/**
 * Route allowlisted Better Auth requests through `auth.handler` and harden
 * response caching: public discovery surfaces (`/jwks`, well-known metadata)
 * stay cacheable while every session-bearing surface is pinned to `no-store`.
 * Discovery metadata bodies drop the RFC 9207 `iss` advertisement for MCP
 * clients only. Disallowed paths 404 before reaching `auth.handler`.
 *
 * The client-address header is stamped here, not only in middleware: the
 * middleware matcher's extension exclusion lets extension-suffixed paths
 * (e.g. `/reset-password/<token>.json`) reach this handler unstamped. The
 * stamped request is rebuilt from `request.url`, never from the request
 * object: `@opennextjs/cloudflare` replaces `globalThis.Request` with a shim
 * that rejects a Request as input. Its body is buffered rather than
 * forwarded as a stream, because a stream body needs `duplex`, which undici
 * requires and workerd does not implement. `content-length` is dropped
 * because the rebuilt request re-derives it.
 *
 * @param request - Incoming GET or POST to `/api/auth/*`.
 * @returns Better Auth's response with a project-owned Cache-Control, or 404.
 */
async function handler(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const path = normalizeAuthPath(pathname);
  if (
    path === null ||
    (!ALLOWED_PATHS.has(path) &&
      !ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix)))
  ) {
    return new Response("Not Found", { status: 404 });
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  stampClientIpHeader(headers);
  const handled = await auth.handler(
    await buildForwardedRequest(request, path, headers),
  );
  const response = PUBLIC_CACHEABLE_PATHS.has(path)
    ? ensureCacheControl(handled, JWKS_CACHE_CONTROL)
    : ensureNoStore(handled);
  if (DISCOVERY_METADATA_PATHS.has(path)) {
    return applyIssAdvertisementCompat(request, response);
  }
  return response;
}

export const GET = handler;
export const POST = handler;
