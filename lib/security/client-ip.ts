import { getIPFromHeader, normalizeIP } from "@better-auth/core/utils/ip";
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
 * bucket, i.e. only where {@link hasTrustedAddressSource} is false.
 *
 * A budget sized for one caller becomes an instance-wide ceiling the moment
 * identity collapses, and 5 sign-ins per minute for a whole deployment denies
 * service to ordinary traffic: a handful of colleagues signing in at the same
 * time lock each other out, and one caller can hold every login closed. So the
 * shared bucket is scaled to an aggregate ceiling instead.
 *
 * This is looser than a declared deployment and much tighter than no policy at
 * all. Before this policy a caller who sent a proxy header picked its own
 * bucket, so the brute-force budget bounded nothing; here it is bounded, just
 * across the instance rather than per caller. Declaring
 * `TRUSTED_PROXY_HEADER` restores the tight per-address budgets, which is why
 * the unresolved-address warning names it.
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
 * CDN's header instead. Fail closed, so an unset value, {@link
 * NO_TRUSTED_HEADER}, or a malformed name all trust nothing.
 *
 * @returns Lower-cased header name, or `null` when no header may be read.
 */
export function trustedProxyHeader(): string | null {
  const raw = process.env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  if (!raw || raw === NO_TRUSTED_HEADER || !HEADER_NAME_RE.test(raw)) {
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

/**
 * Select the client address from a forwarded chain.
 *
 * Delegates to the resolver Better Auth uses on the same request, passing
 * {@link trustedProxies}, so both sides walk the chain identically: from the
 * right, past each declared proxy, to the first hop the deployment did not
 * declare. That is the MDN and Express `trust proxy` algorithm, and sharing the
 * implementation is what keeps the rate-limit identity, `session.ipAddress` and
 * the legal-acceptance evidence naming the same caller. It also accepts CIDR
 * ranges in the list, which a hand-rolled hop walk cannot.
 *
 * It returns null when the chain carries more than one hop and no proxy is
 * declared, because it cannot then tell a proxy from a caller-prepended entry.
 * The rightmost valid hop is the fallback for that case: with a single reverse
 * proxy that is the address the proxy observed, and behind several it is the
 * innermost proxy, which under-attributes traffic to a shared bucket but never
 * lets a caller choose its own bucket. The leftmost entry, the only one a
 * caller controls, is never selected either way.
 *
 * The fallback hop is masked to {@link IPV6_SUBNET_BITS}. `normalizeIP` does
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
  const attributed = getIPFromHeader(value, {
    ipv6Subnet: IPV6_SUBNET_BITS,
    trustedProxies: trustedProxies(),
  });
  if (attributed) return attributed;

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
