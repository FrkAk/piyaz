/**
 * Better Auth surfaces whose responses are public and shared-cacheable — the
 * signing keys and the OAuth discovery metadata. One module so the two
 * consumers cannot drift: the auth route selects the public Cache-Control by
 * this set, and the middleware withholds RateLimit response headers on the
 * same paths, because the counters are per-caller state and a shared cache
 * would replay one caller's numbers to every other
 * (draft-ietf-httpapi-ratelimit-headers, RateLimit fields are per partition
 * key).
 */

/** Auth basePath every path in {@link PUBLIC_CACHEABLE_AUTH_PATHS} is relative to. */
export const AUTH_BASE_PATH = "/api/auth";

/** Public, shared-cacheable auth paths, relative to {@link AUTH_BASE_PATH}. */
export const PUBLIC_CACHEABLE_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/jwks",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
]);

/**
 * Whether a full request pathname names a public-cacheable auth surface.
 *
 * @param pathname - Full request pathname (e.g. `/api/auth/jwks`).
 * @returns `true` when the path serves a shared-cacheable auth document.
 */
export function isPublicCacheableAuthPath(pathname: string): boolean {
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) return false;
  const path = pathname.slice(AUTH_BASE_PATH.length).replace(/\/+$/, "");
  return PUBLIC_CACHEABLE_AUTH_PATHS.has(path);
}
