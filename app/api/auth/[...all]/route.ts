import { auth } from "@/lib/auth";

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
 * to any org member. Self-service / password-reset / email-verification
 * routes are likewise omitted; the UI does not call them today.
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

const BASE_PATH = "/api/auth";

function isAllowed(pathname: string): boolean {
  if (pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) {
    return false;
  }
  const stripped =
    pathname === BASE_PATH ? "/" : pathname.slice(BASE_PATH.length);
  const normalized = stripped.replace(/\/+$/, "") || "/";
  return ALLOWED_PATHS.has(normalized);
}

async function handler(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (!isAllowed(pathname)) {
    return new Response("Not Found", { status: 404 });
  }
  return auth.handler(request);
}

export const GET = handler;
export const POST = handler;
