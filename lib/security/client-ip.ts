import * as z from "zod";

/**
 * Proxy headers consulted only when the deployment declares a trusted proxy.
 * `cf-connecting-ip` is included because self-hosting behind the Cloudflare
 * proxy is a supported topology, and it is the header that edge sets.
 */
const FORWARDED_HEADERS = [
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
] as const;

/** Bucket key used when no trustworthy client address can be resolved. */
export const UNTRUSTED_IP_KEY = "no-trusted-ip";

/**
 * Whether the running build targets Cloudflare Workers. Read per call rather
 * than captured at module load so tests can flip the target.
 *
 * @returns `true` when `DEPLOY_TARGET` is `cloudflare`.
 */
function isCloudflareTarget(): boolean {
  return process.env.DEPLOY_TARGET === "cloudflare";
}

/**
 * Trusted reverse-proxy addresses declared by the deployment, parsed from the
 * comma-separated `TRUSTED_PROXIES` environment variable.
 *
 * @returns Trimmed entries, empty when the variable is unset or blank.
 */
export function trustedProxies(): string[] {
  const raw = process.env.TRUSTED_PROXIES;
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Whether a string is a syntactically valid IPv4 or IPv6 address. Guards every
 * value that becomes a rate-limit key or is persisted as acceptance evidence,
 * so an arbitrary-length attacker string can never reach either.
 *
 * @param value - Candidate address.
 * @returns `true` when the value parses as IPv4 or IPv6.
 */
export function isValidIp(value: string): boolean {
  return z.ipv4().safeParse(value).success || z.ipv6().safeParse(value).success;
}

/**
 * Select the client address from a forwarded chain.
 *
 * The leftmost entry is attacker-supplied, so the rightmost valid address is
 * taken instead: with a single reverse proxy that is the address the proxy
 * observed. Behind several proxies it resolves to the outermost proxy rather
 * than the client, which under-attributes traffic to a shared bucket but never
 * lets a caller choose its own bucket.
 *
 * @param value - Raw header value, possibly a comma-separated chain.
 * @returns The selected address, or `null` when no entry is a valid IP.
 */
function selectFromChain(value: string): string | null {
  const hops = value
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (hop && isValidIp(hop)) return hop;
  }
  return null;
}

/**
 * Resolve the client address under the deployment's trust policy.
 *
 * On the Cloudflare target only `cf-connecting-ip` is consulted, because the
 * edge sets it and a client cannot choose its value. On every other target the
 * forwarded headers are ignored unless `TRUSTED_PROXIES` declares a proxy in
 * front, since nothing else stops a caller from supplying them directly.
 * Declaring a proxy asserts that it overwrites or strips these headers on
 * inbound requests; a proxy that passes them through leaves the address
 * caller-controlled. The resolved value is always shape-validated.
 *
 * @param headers - Request headers to read the proxy chain from.
 * @returns Client address, or `null` when none can be trusted.
 */
export function resolveClientIp(headers: Headers): string | null {
  if (isCloudflareTarget()) {
    const edgeIp = headers.get("cf-connecting-ip");
    return edgeIp && isValidIp(edgeIp) ? edgeIp : null;
  }
  if (trustedProxies().length === 0) return null;
  for (const header of FORWARDED_HEADERS) {
    const value = headers.get(header);
    const selected = value ? selectFromChain(value) : null;
    if (selected) return selected;
  }
  return null;
}

/**
 * Resolve the client address for use as a rate-limit key, collapsing every
 * unattributable caller into one shared bucket.
 *
 * @param headers - Request headers to read the proxy chain from.
 * @returns Client address, or {@link UNTRUSTED_IP_KEY}.
 */
export function clientIpKey(headers: Headers): string {
  return resolveClientIp(headers) ?? UNTRUSTED_IP_KEY;
}
