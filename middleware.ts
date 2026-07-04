import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import {
  matchRule,
  extractKey,
  rateLimitHeaders,
  mcpRateLimitMessage,
  getBackend,
} from "@/lib/api/rate-limit";
import { buildCsp } from "@/lib/security/headers";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Generate a per-request CSP nonce. Edge-runtime compatible: avoids
 * `Buffer` so the Cloudflare Workers / Edge build accepts the module.
 *
 * @returns Base64-encoded UUID v4 (122 bits of entropy).
 */
function generateNonce(): string {
  return btoa(crypto.randomUUID());
}

/**
 * Next.js middleware: session enforcement, rate limiting, request
 * validation, and per-request CSP. API/MCP auth is delegated to route
 * handlers. Runs in the Edge runtime so the OpenNext Cloudflare build
 * accepts the module — Next 16's `proxy.ts` filename is locked to the
 * Node.js runtime which workerd rejects.
 *
 * @param request - Incoming request.
 * @returns Redirect, error response, or pass-through; all carry CSP headers.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const session = getSessionCookie(request);

  const isProd = process.env.NODE_ENV === "production";
  const nonce = isProd ? generateNonce() : undefined;
  const wsScheme = request.nextUrl.protocol === "https:" ? "wss" : "ws";
  const wsOrigin =
    isProd && process.env.NEXT_PUBLIC_DEPLOY_TARGET === "cloudflare"
      ? `${wsScheme}://${request.nextUrl.host}`
      : undefined;
  const csp = buildCsp({ isProd, nonce, wsOrigin });
  const withCsp = <T extends NextResponse>(response: T): T => {
    response.headers.set("Content-Security-Policy", csp);
    return response;
  };

  // Auth pages: redirect to home if already signed in
  if (session && (pathname === "/sign-in" || pathname === "/sign-up")) {
    return withCsp(NextResponse.redirect(new URL("/", request.url)));
  }

  // Protected app pages: redirect to sign-in if not authenticated.
  // Only auth endpoints and MCP routes are public — all other API
  // routes require a session cookie to prevent unauthenticated access.
  const isPublicPath =
    pathname === "/sign-in" ||
    pathname === "/sign-up" ||
    pathname === "/consent" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/api/mcp" ||
    pathname.startsWith("/.well-known/");
  if (!session && !isPublicPath) {
    return withCsp(NextResponse.redirect(new URL("/sign-in", request.url)));
  }

  // Rate limiting — routed by rule.bindingKey so `/api/auth/*` paths hit the
  // RATE_LIMIT_AUTH binding (defense-in-depth on top of Better-Auth's in-memory
  // customRules) and the rest of `/api/*` hits RATE_LIMIT_API.
  let rlHeaders: Record<string, string> | null = null;
  const rule = matchRule(pathname);
  if (rule) {
    const key = await extractKey(request, rule.keyStrategy);
    if (key) {
      const result = await getBackend(rule.bindingKey).check(
        `${rule.pattern}:${key}`,
        rule.max,
        rule.window,
      );
      rlHeaders = rateLimitHeaders(result, rule);
      if (!result.allowed) {
        const message =
          rule.bindingKey === "mcp"
            ? mcpRateLimitMessage(rule.max, rule.window, result.resetIn)
            : "Too many requests. Please try again later.";
        return withCsp(
          NextResponse.json(
            { error: message },
            { status: 429, headers: rlHeaders },
          ),
        );
      }
    }
  }

  // UUID validation for project routes
  const match = pathname.match(/^\/api\/project\/([^/]+)/);
  if (match && !UUID_RE.test(match[1])) {
    return withCsp(
      NextResponse.json({ error: "Invalid project ID" }, { status: 400 }),
    );
  }

  // Forward `x-nonce` so the renderer auto-tags inline <script> elements.
  const requestHeaders = new Headers(request.headers);
  if (nonce) {
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", csp);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  if (rlHeaders) {
    for (const [k, v] of Object.entries(rlHeaders)) {
      response.headers.set(k, v);
    }
  }
  return withCsp(response);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|json|webmanifest)$).*)",
  ],
};
