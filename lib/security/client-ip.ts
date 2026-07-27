import { normalizeIP } from "@better-auth/core/utils/ip";
import * as z from "zod";

/** Header the Cloudflare edge sets on the hosted target. */
const EDGE_HEADER = "cf-connecting-ip";

/**
 * Prefix length an IPv6 address is masked to before it becomes an identity.
 *
 * The low 64 bits are the interface identifier (RFC 4291), which a host picks
 * and rotates on its own, so the full address is caller-chosen: rotating it
 * mints a fresh bucket per request and defeats every per-address budget, the
 * same way a rotated cookie or bearer token would. /64 is the narrowest
 * boundary that survives that rotation. End sites are assigned something
 * shorter (RFC 6177 leaves the size to the operator, commonly /56 or /48), so
 * a caller with a larger allocation still holds several buckets; masking
 * further would start pooling unrelated subscribers behind one budget. Better
 * Auth masks to /64 by default and `lib/auth.ts` pins this same value, so the
 * two resolvers cannot drift.
 */
export const IPV6_SUBNET_BITS = 64;

/** RFC 7230 field-name shape, guarding `Headers.get`, which throws otherwise. */
const HEADER_NAME_RE = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;

/** Bucket key used when no trustworthy client address can be resolved. */
export const UNTRUSTED_IP_KEY = "no-trusted-ip";

/** Whether the unresolvable-address warning has already been emitted. */
let untrustedWarningLogged = false;

/**
 * Warn once per isolate that no client address could be resolved.
 *
 * Every per-address budget collapses into one shared bucket in this state, so
 * a single busy caller can throttle everyone. That is the safe direction, but
 * a deployment behind a reverse proxy almost certainly meant to declare it,
 * and the symptom (unrelated users seeing 429s) points nowhere near the cause.
 * Mirrors the warning Better Auth emits for the same condition.
 */
function warnUntrustedOnce(): void {
  if (untrustedWarningLogged) return;
  untrustedWarningLogged = true;
  console.warn(
    JSON.stringify({
      event: "client_ip_unresolved",
      hint:
        "No trusted client address could be resolved, so every caller shares " +
        "one rate-limit bucket and no IP is recorded on legal acceptance. Set " +
        "TRUSTED_PROXY_HEADER to the header the reverse proxy in front of " +
        "this deployment overwrites on inbound requests.",
    }),
  );
}

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
 * Refines attribution rather than granting trust: {@link trustedProxyHeader}
 * decides whether any header is read at all. Better Auth consumes this list to
 * walk a forwarded chain past its own proxies (CIDR ranges included), which
 * matters where a proxy appends to the chain instead of replacing it.
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
 * The single request header a self-hosted deployment's reverse proxy is
 * declared to control, from `TRUSTED_PROXY_HEADER`.
 *
 * One operator-named header rather than a list tried in order: trying several
 * means the first one that parses wins, and a caller can always supply a
 * header the proxy does not set. `x-forwarded-for` and `x-real-ip` are the
 * usual answers; a deployment that does front itself with a CDN names that
 * CDN's header instead. Fail closed, so an unset value trusts nothing.
 *
 * @returns Lower-cased header name, or `null` when unset or not a valid field name.
 */
export function trustedProxyHeader(): string | null {
  const raw = process.env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  if (!raw || !HEADER_NAME_RE.test(raw)) return null;
  return raw;
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
 * The selected hop is masked to {@link IPV6_SUBNET_BITS}. `normalizeIP` does
 * not validate, and hands back anything it cannot parse lowercased and
 * otherwise untouched, so it runs only on a hop {@link isValidIp} has already
 * accepted. IPv4 passes through unchanged and an IPv4-mapped IPv6 address
 * collapses to its bare IPv4 form, so a dual-stack client gets one bucket
 * rather than two.
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
    if (hop && isValidIp(hop)) {
      return normalizeIP(hop, { ipv6Subnet: IPV6_SUBNET_BITS });
    }
  }
  return null;
}

/**
 * Resolve the client address under the deployment's trust policy.
 *
 * The hosted target reads `cf-connecting-ip` and nothing else: the edge sets
 * it on every request and a client cannot choose its value. Self-host reads
 * exactly the header {@link trustedProxyHeader} names and nothing else, so a
 * caller cannot reach the resolver through a header the proxy leaves
 * untouched. That is why `cf-connecting-ip` is absent from this path unless an
 * operator names it: a self-hosted deployment has no edge setting it, and
 * common reverse proxies forward it verbatim. With no header named, no address
 * resolves. The selected value is always shape-validated and masked.
 *
 * Better Auth reads the same header under `lib/auth.ts:ipAddressPolicy` and
 * masks to the same width. The two agree on the hosted target, where the
 * header carries a single address; on self-host behind a chain-appending proxy
 * they can pick different hops, which that function documents.
 *
 * @param headers - Request headers to read the proxy chain from.
 * @returns Client address, or `null` when none can be trusted.
 */
export function resolveClientIp(headers: Headers): string | null {
  const header = isCloudflareTarget() ? EDGE_HEADER : trustedProxyHeader();
  if (!header) return null;
  const value = headers.get(header);
  return value ? selectFromChain(value) : null;
}

/**
 * Resolve the client address for use as a rate-limit key, collapsing every
 * unattributable caller into one shared bucket.
 *
 * @param headers - Request headers to read the proxy chain from.
 * @returns Client address, or {@link UNTRUSTED_IP_KEY}.
 */
export function clientIpKey(headers: Headers): string {
  const address = resolveClientIp(headers);
  if (address) return address;
  warnUntrustedOnce();
  return UNTRUSTED_IP_KEY;
}
