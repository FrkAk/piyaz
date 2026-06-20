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
 * Build Next.js header rules: always-on security headers plus production
 * HSTS scoped to non-loopback hosts.
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

  // Pin `Cache-Control: no-store` on the rendered auth pages so a shared
  // cache (CDN, corporate proxy, browser bfcache) cannot store and replay
  // session-bearing HTML to a different user. Exact-source patterns: each
  // route is a single Next page. Independent of `isProd` — caching dev
  // sign-in HTML is the same fixation risk in a different deployment.
  rules.push(
    { source: "/sign-in", headers: [{ key: "Cache-Control", value: "no-store" }] },
    { source: "/sign-up", headers: [{ key: "Cache-Control", value: "no-store" }] },
    { source: "/consent", headers: [{ key: "Cache-Control", value: "no-store" }] },
  );

  return rules;
}
