import {
  findInvalidTrustedProxies,
  getIPFromHeader,
  normalizeIP,
} from "@better-auth/core/utils/ip";
import * as z from "zod";

/** Header the Cloudflare edge sets on the hosted target. */
const EDGE_HEADER = "cf-connecting-ip";

/**
 * Internal header carrying the address {@link resolveClientIp} resolved for
 * this request. Better Auth reads only this header, so both limbs share one
 * identity by construction.
 *
 * Trust contract: the value is only meaningful after {@link
 * stampClientIpHeader} ran. Middleware stamps every matched request, and every
 * route that hands a request-controlled `Request` to `auth.handler` must stamp
 * again before the call, because the middleware matcher's extension exclusion
 * lets some paths reach a handler without it. The name is reserved:
 * {@link trustedProxyHeader} refuses it and {@link addressPolicyError} fails
 * boot on it, so the resolver can never read the header the app itself writes.
 */
export const INTERNAL_CLIENT_IP_HEADER = "x-piyaz-client-ip";

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

/**
 * `TRUSTED_PROXY_HEADER` value declaring that no header here is trustworthy.
 *
 * Distinguishes "nothing in front of this deployment sets one" from "the
 * operator has not decided yet". Both resolve no address, but only the first is
 * a choice, so {@link addressPolicyError} accepts this and rejects an unset
 * variable.
 */
const NO_TRUSTED_HEADER = "none";

/** Bucket key used when no trustworthy client address can be resolved. */
export const UNTRUSTED_IP_KEY = "no-trusted-ip";

/**
 * Multiplier applied to a per-address budget once every caller shares one
 * bucket. A budget sized for one caller becomes an instance-wide ceiling the
 * moment identity collapses, so the shared bucket is scaled to an aggregate
 * ceiling: bounded, but across the instance rather than per caller.
 */
export const UNTRUSTED_BUDGET_FACTOR = 20;

/** Whether the unresolvable-address warning has already been emitted. */
let untrustedWarningLogged = false;

/**
 * Warn once per isolate that no client address could be resolved.
 *
 * Every per-address budget collapses into one shared bucket in this state, so
 * a single busy caller can throttle everyone. {@link UNTRUSTED_BUDGET_FACTOR}
 * keeps that from denying service outright, but the budgets are instance-wide
 * rather than per caller, no IP reaches the acceptance evidence, and the
 * symptom (unrelated users seeing 429s) points nowhere near the cause.
 * Mirrors the warning Better Auth emits for the same condition.
 */
function warnUntrustedOnce(): void {
  if (untrustedWarningLogged) return;
  untrustedWarningLogged = true;
  console.warn(
    JSON.stringify({
      event: "client_ip_unresolved",
      hint:
        "No trusted client address could be resolved, so rate-limit budgets " +
        "are shared across every caller and no IP is recorded on legal " +
        "acceptance. Set TRUSTED_PROXY_HEADER to the header the reverse proxy " +
        "in front of this deployment overwrites on inbound requests.",
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
 * decides whether any header is read at all. {@link resolveClientIp} walks a
 * forwarded chain past these proxies (CIDR ranges included), which matters
 * where a proxy appends to the chain instead of replacing it. Entries that do
 * not parse fail boot via {@link addressPolicyError}.
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
 * CDN's header instead. Fail closed, so an unset value, {@link
 * NO_TRUSTED_HEADER}, a malformed name, or the reserved
 * {@link INTERNAL_CLIENT_IP_HEADER} all trust nothing.
 *
 * @returns Lower-cased header name, or `null` when no header may be read.
 */
export function trustedProxyHeader(): string | null {
  const raw = process.env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  if (
    !raw ||
    raw === NO_TRUSTED_HEADER ||
    raw === INTERNAL_CLIENT_IP_HEADER ||
    !HEADER_NAME_RE.test(raw)
  ) {
    return null;
  }
  return raw;
}

/**
 * Check that a self-hosted deployment has declared how callers are identified.
 *
 * Every credential-path budget keys on the client address, so leaving this
 * undeclared silently moves the whole instance onto shared counters and drops
 * the IP from legal-acceptance evidence. Both outcomes are invisible until
 * unrelated users start seeing 429s, so the decision is required rather than
 * defaulted. Naming {@link NO_TRUSTED_HEADER} is a valid answer and keeps the
 * instance serving under {@link UNTRUSTED_BUDGET_FACTOR}.
 *
 * @returns An operator-facing message, or `null` when the policy is usable.
 */
export function addressPolicyError(): string | null {
  const raw = process.env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  if (!raw) {
    return (
      "TRUSTED_PROXY_HEADER is required off the Cloudflare deploy target. " +
      "Rate limiting and the IP recorded on legal acceptance identify a caller " +
      "by address, and every proxy header is caller-supplied unless something " +
      "upstream overwrites it, so this names the one header your reverse proxy " +
      "sets on inbound requests (commonly x-forwarded-for or x-real-ip). Set " +
      `it to "${NO_TRUSTED_HEADER}" if nothing in front of this deployment ` +
      "sets one; every caller then shares one throttling budget and no IP is " +
      "recorded. See .env.local.example."
    );
  }
  if (raw !== NO_TRUSTED_HEADER && !HEADER_NAME_RE.test(raw)) {
    return (
      `TRUSTED_PROXY_HEADER is not a valid header name: "${raw}". Name one ` +
      `request header, or "${NO_TRUSTED_HEADER}" to trust none.`
    );
  }
  if (raw === INTERNAL_CLIENT_IP_HEADER) {
    return (
      `TRUSTED_PROXY_HEADER cannot be "${INTERNAL_CLIENT_IP_HEADER}": that ` +
      "header is written by the app itself after resolution. Name the header " +
      `your reverse proxy sets, or "${NO_TRUSTED_HEADER}".`
    );
  }
  const invalidProxies = findInvalidTrustedProxies(trustedProxies());
  if (invalidProxies.length > 0) {
    return (
      "TRUSTED_PROXIES contains entries that are not an IP address or CIDR " +
      `range: ${invalidProxies.map((entry) => `"${entry}"`).join(", ")}. ` +
      "Invalid entries silently disable forwarded-chain attribution, so they " +
      "refuse boot instead."
    );
  }
  return null;
}

/**
 * Whether this deployment declares any way to identify a caller by address.
 *
 * True on the hosted target, where the edge sets {@link EDGE_HEADER} on every
 * request, and on a self-host instance that names a header. False otherwise,
 * which is the state where every per-address budget collapses into one bucket
 * and {@link UNTRUSTED_BUDGET_FACTOR} applies. Gating on the declaration rather
 * than on a single request's outcome keeps the hosted budgets untouched even
 * when an individual request carries no address, so the advertised limit never
 * drifts from what the Cloudflare bindings enforce.
 *
 * @returns `true` when an address source is declared.
 */
export function hasTrustedAddressSource(): boolean {
  return isCloudflareTarget() || trustedProxyHeader() !== null;
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

/** Bracket-form IPv6 hop with an optional port: `[2001:db8::5]:443`. */
const BRACKETED_V6_RE = /^\[([^\]]+)\](?::\d{1,5})?$/;

/** Dotted-quad IPv4 hop with a port: `203.0.113.5:41234`. */
const V4_PORT_RE = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;

/**
 * Strip a well-formed port suffix from a forwarded hop.
 *
 * A hop that already validates as an address is returned untouched, so a bare
 * IPv6 is never split on its colons: RFC 3986 requires brackets for an IPv6
 * with a port, so an unbracketed colon form is inherently an address. Only the
 * bracket form and a full dotted-quad with digits after the colon are
 * stripped, the shapes Azure Application Gateway, Azure App Service and IIS
 * ARR append.
 *
 * @param hop - One trimmed entry of a forwarded chain.
 * @returns The hop without its port, or `null` when no address shape matches.
 */
function stripPortSuffix(hop: string): string | null {
  if (isValidIp(hop)) return hop;
  const bracketed = BRACKETED_V6_RE.exec(hop);
  if (bracketed?.[1]) return bracketed[1];
  const v4Port = V4_PORT_RE.exec(hop);
  if (v4Port?.[1]) return v4Port[1];
  return null;
}

/**
 * Select the client address from a forwarded chain.
 *
 * Port suffixes are stripped from every hop before the walk: `getIPFromHeader`
 * aborts on the first unparseable hop, so a proxy that appends `ip:port` would
 * otherwise disable chain attribution entirely. The walk itself is Better
 * Auth's, passing {@link trustedProxies}: from the right, past each declared
 * proxy (CIDR ranges included), to the first undeclared hop.
 *
 * When the walk resolves nothing, the fallback is the rightmost hop only:
 * valid, it is the address the innermost proxy observed; invalid, the request
 * is unattributable and resolves `null`. Everything left of the rightmost hop
 * is caller-supplied bytes and is never selected. The selected hop is masked
 * to {@link IPV6_SUBNET_BITS}; `normalizeIP` does not validate, so it runs
 * only on a hop {@link isValidIp} has accepted.
 *
 * @param value - Raw header value, possibly a comma-separated chain.
 * @returns The selected address, or `null` when none can be attributed.
 */
function selectFromChain(value: string): string | null {
  const hops = value
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean)
    .map((hop) => stripPortSuffix(hop) ?? hop);
  if (hops.length === 0) return null;

  const attributed = getIPFromHeader(hops.join(", "), {
    ipv6Subnet: IPV6_SUBNET_BITS,
    trustedProxies: trustedProxies(),
  });
  if (attributed) return attributed;

  const rightmost = hops[hops.length - 1];
  if (!rightmost || !isValidIp(rightmost)) return null;
  return normalizeIP(rightmost, { ipv6Subnet: IPV6_SUBNET_BITS });
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
 * This is the only resolver. Better Auth reads {@link
 * INTERNAL_CLIENT_IP_HEADER}, which {@link stampClientIpHeader} fills from
 * this function, so both limbs name the same caller by construction.
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
 * Stamp {@link INTERNAL_CLIENT_IP_HEADER} with the resolved client address.
 *
 * Always sets, never deletes: on the Cloudflare target OpenNext merges
 * middleware header overrides additively, so a deletion is a no-op there while
 * a set always wins over a caller-supplied value. An empty value marks an
 * unattributable request; both consumers treat it as no address.
 *
 * @param headers - Mutable request headers to stamp.
 */
export function stampClientIpHeader(headers: Headers): void {
  headers.set(INTERNAL_CLIENT_IP_HEADER, resolveClientIp(headers) ?? "");
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
