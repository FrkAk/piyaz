const COMMON_DIRECTIVES = [
  "default-src 'self'",
  // `'unsafe-inline'` required for `style="…"` attributes; CSP nonces cover
  // `<style>` elements only. Tracked for refactor to class-based styles.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
];

const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), interest-cohort=()";

const HSTS_VALUE = "max-age=31536000; includeSubDomains";

/**
 * Cache-Control for the rendered auth pages. Matches the directive Next emits
 * for a dynamically-rendered page (`getCacheControlHeader({ revalidate: 0 })`).
 * These pages render dynamically today (the root layout reads `cookies()`), so
 * this never downgrades the framework default; it also stops a shared cache
 * (CDN, proxy) from storing session-bearing auth HTML should a page ever be
 * statically prerendered.
 */
const AUTH_PAGE_CACHE_CONTROL =
  "private, no-cache, no-store, max-age=0, must-revalidate";

/** Anchored regex matching loopback Host headers excluded from HSTS. */
const LOOPBACK_HOST_REGEX = "^(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?$";

/** Single header entry, matching the `{ key, value }` shape `next.config.ts` `headers()` expects. */
type HeaderEntry = { key: string; value: string };

/** Single rule entry returned by `next.config.ts` `headers()`. */
export type HeaderRule = {
  source: string;
  headers: HeaderEntry[];
  missing?: Array<{ type: "host"; value: string }>;
};

/**
 * Build the Content-Security-Policy header value.
 *
 * @param opts.isProd - True when running in production.
 * @param opts.nonce - Per-request nonce. Required when `isProd` is true.
 * @param opts.wsOrigin - Same-origin WebSocket origin (e.g. `wss://app.host`)
 *   to allow in `connect-src`. Set on the Cloudflare deploy, whose realtime
 *   runs over a same-origin WebSocket; `'self'` alone does not reliably match
 *   `wss:` schemes across browsers (w3c/webappsec-csp#7). Passing the exact
 *   origin keeps the allowance same-origin only, rather than the blanket
 *   `wss:` scheme that would let injected script reach any host.
 * @returns Serialized CSP directive string.
 * @throws Error if `isProd` is true and no `nonce` is supplied.
 */
export function buildCsp(opts: {
  isProd: boolean;
  nonce?: string;
  wsOrigin?: string;
}): string {
  const { isProd, nonce, wsOrigin } = opts;

  let scriptSrc: string;
  let connectSrc: string;
  let workerSrc: string;

  if (isProd) {
    if (!nonce) {
      throw new Error("buildCsp: nonce is required in production");
    }
    scriptSrc = `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
    connectSrc = wsOrigin
      ? `connect-src 'self' ${wsOrigin}`
      : "connect-src 'self'";
    workerSrc = "worker-src 'self'";
  } else {
    scriptSrc = "script-src 'self' 'unsafe-eval' 'unsafe-inline'";
    connectSrc = "connect-src 'self' ws: wss:";
    workerSrc = "worker-src 'self' blob:";
  }

  const directives = [...COMMON_DIRECTIVES, scriptSrc, connectSrc, workerSrc];
  if (isProd) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/**
 * Static security response headers applied to every route.
 *
 * Excludes CSP (set per-request by `middleware.ts`) and HSTS (host-scoped,
 * see `headerRules`).
 *
 * @returns Header entries for a Next.js header rule.
 */
export function securityHeaders(): HeaderEntry[] {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-site" },
  ];
}

/**
 * Backfill a `Cache-Control` value on a response that lacks the header. Next
 * does not apply its page-level Cache-Control default to route handlers, so
 * auth API surfaces otherwise ship with none. Guarded with `has` so an
 * upstream-owned directive (e.g. Better Auth's public hint on the discovery
 * metadata) passes through unchanged.
 *
 * @param response - Response to harden in place.
 * @param value - Cache-Control to set when the response carries none.
 * @returns The same response, with a `Cache-Control` ensured.
 */
export function ensureCacheControl(
  response: Response,
  value: string,
): Response {
  if (!response.headers.has("cache-control")) {
    response.headers.set("cache-control", value);
  }
  return response;
}

/**
 * Pin `Cache-Control: no-store` on a session-bearing auth response that lacks
 * the header, so shared caches cannot store and replay it.
 *
 * @param response - Response to harden in place.
 * @returns The same response, with `Cache-Control: no-store` ensured.
 */
export function ensureNoStore(response: Response): Response {
  return ensureCacheControl(response, "no-store");
}

/**
 * Build Next.js header rules: always-on security headers, production HSTS
 * scoped to non-loopback hosts, and a non-cacheable Cache-Control on the
 * rendered auth pages (`/sign-in`, `/sign-up`, `/consent`) so a shared cache
 * cannot store and replay session-bearing auth HTML. The auth-page rules apply
 * in every environment — caching dev auth HTML is the same fixation risk.
 *
 * @param isProd - True when `NODE_ENV === 'production'`.
 * @returns Header rules for `next.config.ts` `headers()`.
 */
export function headerRules(isProd: boolean): HeaderRule[] {
  const rules: HeaderRule[] = [
    { source: "/:path*", headers: securityHeaders() },
  ];

  if (isProd) {
    rules.push({
      source: "/:path*",
      missing: [{ type: "host", value: LOOPBACK_HOST_REGEX }],
      headers: [{ key: "Strict-Transport-Security", value: HSTS_VALUE }],
    });
  }

  rules.push(
    {
      source: "/sign-in",
      headers: [{ key: "Cache-Control", value: AUTH_PAGE_CACHE_CONTROL }],
    },
    {
      source: "/sign-up",
      headers: [{ key: "Cache-Control", value: AUTH_PAGE_CACHE_CONTROL }],
    },
    {
      source: "/consent",
      headers: [{ key: "Cache-Control", value: AUTH_PAGE_CACHE_CONTROL }],
    },
  );

  return rules;
}
