import { auth } from "@/lib/auth";
import { ensureCacheControl, ensureNoStore } from "@/lib/security/headers";

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

const BASE_PATH = "/api/auth";

/**
 * Allowlisted paths whose responses are public and carry no session or user
 * data — the signing keys and the OAuth discovery metadata. These stay
 * cacheable; every other allowlisted path is session-bearing and pinned to
 * `no-store`. Better Auth already tags the discovery docs with its own public
 * hint, so `JWKS_CACHE_CONTROL` only ever applies to `/jwks`, which Better
 * Auth leaves header-less.
 */
const PUBLIC_CACHEABLE_PATHS: ReadonlySet<string> = new Set([
  "/jwks",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
]);

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
 * Route allowlisted Better Auth requests through `auth.handler` and harden
 * response caching: public discovery surfaces (`/jwks`, well-known metadata)
 * stay cacheable while every session-bearing surface is pinned to `no-store`.
 * Disallowed paths 404 before reaching `auth.handler`.
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
  const response = await auth.handler(request);
  if (PUBLIC_CACHEABLE_PATHS.has(path)) {
    return ensureCacheControl(response, JWKS_CACHE_CONTROL);
  }
  return ensureNoStore(response);
}

export const GET = handler;
export const POST = handler;
