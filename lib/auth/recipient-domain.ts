import "server-only";

import { isPubliclyRoutable } from "@/lib/auth/ip-routability";

/**
 * Outcome of a recipient-domain deliverability probe.
 *
 * `unknown` is distinct from `undeliverable` on purpose: a DNS outage must
 * not block real sign-ups, so callers treat it as a pass.
 */
export type DeliverabilityVerdict = "deliverable" | "undeliverable" | "unknown";

/** Cloudflare DNS-over-HTTPS resolver. Same-network from a Worker. */
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/** DNS record type numbers used by the probe. */
const RECORD_TYPE = { A: 1, MX: 15, AAAA: 28 } as const;

/** DNS RCODE for a successful response. */
const RCODE_NOERROR = 0;

/** DNS RCODE for an authoritative "no such name" answer. */
const RCODE_NXDOMAIN = 3;

/**
 * How many MX exchanges to resolve before giving up, taken in preference
 * order. A domain is asserted undeliverable only when every exchange was
 * probed; a longer list that exhausts this cutoff without a routable hit
 * fails open instead, because the unprobed exchanges could still accept mail.
 */
const MAX_EXCHANGES_PROBED = 2;

/** Abort budget for a single DoH lookup, in milliseconds. */
const LOOKUP_TIMEOUT_MS = 2000;

/**
 * Abort budget for the whole probe, in milliseconds. Caps the tail added to
 * the sign-up POST when a domain's nameservers blackhole queries; expiry
 * fails the in-flight lookups, which surface as `unknown`.
 */
const PROBE_DEADLINE_MS = 4000;

/** Minimal shape of the DoH JSON response this module reads. */
interface DohResponse {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

/** Stand-in for the live DNS probe. */
type DomainResolver = (domain: string) => Promise<DeliverabilityVerdict>;

let _resolverOverride: DomainResolver | null = null;

/**
 * Replace the live DNS probe, or restore it with `null`.
 *
 * Exists so the test suite stays hermetic: sign-up runs on nearly every auth
 * test, and without this each one would make real DoH requests: slow, network
 * dependent, and wrong (the suite's `@test.local` addresses are NXDOMAIN, so
 * the live probe would reject them). `tests/setup/preload.ts` installs a
 * permissive default; tests that exercise the gate install their own.
 * Mirrors the `setBackend` seam in `lib/api/rate-limit.ts`.
 *
 * @param resolver - Replacement resolver, or `null` to use the live probe.
 */
export function setRecipientDomainResolver(
  resolver: DomainResolver | null,
): void {
  _resolverOverride = resolver;
}

/**
 * Resolve one DNS question through DoH.
 *
 * @param name - Fully-qualified name to query.
 * @param type - Numeric record type.
 * @param deadline - Whole-probe abort signal shared across lookups.
 * @returns Parsed answer data strings, or `null` when the lookup itself failed
 *   (network error, timeout, non-200, SERVFAIL, REFUSED) as opposed to
 *   returning no records.
 */
async function resolve(
  name: string,
  type: number,
  deadline: AbortSignal,
): Promise<string[] | null> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.any([
        deadline,
        AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      ]),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as DohResponse;
    // Only NXDOMAIN is an authoritative "no such name" answer. SERVFAIL,
    // REFUSED, and the rest are resolver-side failures delivered with HTTP
    // 200, and must fail open rather than read as an empty record set.
    if (body.Status === RCODE_NXDOMAIN) return [];
    if (body.Status !== RCODE_NOERROR) return null;
    return (body.Answer ?? [])
      .filter((answer) => answer.type === type)
      .map((answer) => answer.data ?? "")
      .filter((data) => data.length > 0);
  } catch {
    return null;
  }
}

/**
 * Whether a name resolves to at least one publicly routable address.
 *
 * Both families are resolved together. Serialised, one exchange costs two round
 * trips and a domain whose first exchange is dead costs five, which overruns
 * {@link PROBE_DEADLINE_MS} and hands back `unknown` for a domain that is
 * merely slow rather than undeliverable. The cost is one extra lookup when the
 * A record alone would have answered; the verdict cache absorbs that on every
 * repeat probe of the same domain.
 *
 * @param name - Host name to resolve.
 * @param deadline - Whole-probe abort signal shared across lookups.
 * @returns `true` when a routable A or AAAA record exists, `false` when the
 *   name has no address records or only non-routable ones, `null` when a lookup
 *   failed and neither family produced a routable answer.
 */
async function hasRoutableAddress(
  name: string,
  deadline: AbortSignal,
): Promise<boolean | null> {
  const [a, aaaa] = await Promise.all([
    resolve(name, RECORD_TYPE.A, deadline),
    resolve(name, RECORD_TYPE.AAAA, deadline),
  ]);
  if (a?.some(isPubliclyRoutable) === true) return true;
  if (aaaa?.some(isPubliclyRoutable) === true) return true;
  // A routable answer from either family is decisive, so a fault is only
  // reported once neither has one: serialised, an A-lookup fault short-circuits
  // and a v6-reachable exchange reads as unprobeable.
  if (a === null || aaaa === null) return null;
  return false;
}

/** One usable MX record: its delivery preference and its exchange host. */
interface MxRecord {
  preference: number;
  host: string;
}

/**
 * Parse one DoH MX answer (`"10 mx1.example.com."`).
 *
 * The three outcomes are kept distinct because they demand opposite verdicts.
 * RFC 7505 null MX is a domain declaring it refuses mail, which is a hard
 * rejection; an answer this cannot parse is a resolver returning something
 * unexpected, which must fail open like every other resolver fault. Collapsing
 * both into "no exchange" would turn a parser regression into a sign-up outage.
 *
 * @param data - Raw MX answer data.
 * @returns The record, `"null-mx"` for RFC 7505 `"0 ."`, or `null` when the
 *   answer does not parse as an MX at all.
 */
function parseMx(data: string): MxRecord | "null-mx" | null {
  const parts = data.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const preference = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(preference)) return null;
  const host = parts[1].replace(/\.$/, "");
  return host.length > 0 ? { preference, host } : "null-mx";
}

/**
 * How long a settled verdict is reused, by verdict.
 *
 * `deliverable` is effectively static, so it is held long. `undeliverable` is
 * held briefly on purpose: a domain that fixes its MX must not stay rejected,
 * and the cost of re-probing it is three lookups. `unknown` is never stored,
 * because memoizing a resolver fault would stretch a transient outage across
 * the whole window.
 */
export const VERDICT_CACHE_TTL_SECONDS = {
  deliverable: 21_600,
  undeliverable: 900,
} as const;

/** One memoized verdict and the epoch millisecond it stops being reused. */
interface CachedVerdict {
  verdict: DeliverabilityVerdict;
  expiresAt: number;
}

/**
 * Per-process verdict memo.
 *
 * Deliberately in-process rather than KV-backed. Sign-ups concentrate on a
 * short list of recipient domains, so an isolate-local map removes almost all
 * repeat probing for the cost of a `Map`; a shared store would add a binding, a
 * dual-runtime pair, and a network read on every sign-up to raise the hit rate
 * on an endpoint that is already capped at three requests per minute per
 * address. Entries are per-isolate and simply re-probe after a cold start.
 */
const _verdicts = new Map<string, CachedVerdict>();

/**
 * Test-only: drop every memoized verdict so one test's canned zone cannot
 * answer another's probe. Never call from production code.
 */
export function __resetDeliverabilityCacheForTest(): void {
  _verdicts.clear();
}

/**
 * Read a live memoized verdict, dropping it if it has expired.
 *
 * @param domain - Recipient domain.
 * @returns The cached verdict, or `null` when absent or stale.
 */
function readCachedVerdict(domain: string): DeliverabilityVerdict | null {
  const entry = _verdicts.get(domain);
  if (entry === undefined) return null;
  if (entry.expiresAt <= Date.now()) {
    _verdicts.delete(domain);
    return null;
  }
  return entry.verdict;
}

/**
 * Memoize a settled verdict, pruning expired entries so a long-lived process
 * holds only domains probed inside the current window.
 *
 * @param domain - Recipient domain.
 * @param verdict - Settled verdict; `unknown` is never passed here.
 */
function cacheVerdict(
  domain: string,
  verdict: "deliverable" | "undeliverable",
): void {
  const now = Date.now();
  for (const [key, entry] of _verdicts) {
    if (entry.expiresAt <= now) _verdicts.delete(key);
  }
  _verdicts.set(domain, {
    verdict,
    expiresAt: now + VERDICT_CACHE_TTL_SECONDS[verdict] * 1000,
  });
}

/**
 * Probe whether a recipient domain can actually receive mail.
 *
 * Follows RFC 5321 §5.1 delivery resolution: prefer MX records, fall back to
 * the domain's own address records when no MX is published. An MX whose
 * exchange does not resolve is not a delivery target, which is the case this
 * exists to catch. A domain can publish a syntactically valid MX pointing at
 * a host that has no address record, so the address passes every format check
 * yet every send to it hard-bounces and burns sender reputation.
 *
 * Fails open: any resolver failure yields `unknown` so a DNS outage degrades
 * to today's behavior instead of blocking sign-ups.
 *
 * @param domain - The recipient domain (the part after `@`), already lowercased.
 * @returns The deliverability verdict for the domain.
 */
export async function checkRecipientDomain(
  domain: string,
): Promise<DeliverabilityVerdict> {
  if (_resolverOverride !== null) return _resolverOverride(domain);
  const cached = readCachedVerdict(domain);
  if (cached !== null) return cached;
  const verdict = await probeRecipientDomain(domain);
  if (verdict !== "unknown") cacheVerdict(domain, verdict);
  return verdict;
}

/**
 * Resolve a domain's deliverability from DNS, with no memoization.
 *
 * @param domain - The recipient domain, already lowercased and A-label mapped.
 * @returns The deliverability verdict for the domain.
 */
async function probeRecipientDomain(
  domain: string,
): Promise<DeliverabilityVerdict> {
  const deadline = AbortSignal.timeout(PROBE_DEADLINE_MS);
  const mx = await resolve(domain, RECORD_TYPE.MX, deadline);
  if (mx === null) return "unknown";

  if (mx.length === 0) {
    // No MX at all: RFC 5321 §5.1 falls back to the domain's own address
    // records, treating them as an implicit MX of preference 0.
    const implicit = await hasRoutableAddress(domain, deadline);
    if (implicit === null) return "unknown";
    return implicit ? "deliverable" : "undeliverable";
  }

  const parsed = mx.map(parseMx);

  // RFC 7505 §3 defines `0 .` as the domain declaring it accepts no mail, and
  // forbids advertising any other MX alongside it. The A/AAAA fallback is then
  // barred by RFC 5321 §5.1 ("If MX records are present, but none of them are
  // usable, this situation MUST be reported as an error"), so a domain that
  // hosts a website still refuses mail.
  if (parsed.includes("null-mx")) return "undeliverable";

  const exchanges = parsed
    .filter((record): record is MxRecord => record !== null)
    .sort((a, b) => a.preference - b.preference)
    .map((record) => record.host);

  // MX records exist but not one of them parsed. That is a resolver returning
  // something unexpected, not a domain refusing mail, so it fails open.
  if (exchanges.length === 0) return "unknown";

  let sawResolverFailure = false;
  for (const exchange of exchanges.slice(0, MAX_EXCHANGES_PROBED)) {
    const reachable = await hasRoutableAddress(exchange, deadline);
    if (reachable === null) {
      sawResolverFailure = true;
      continue;
    }
    if (reachable) return "deliverable";
  }
  if (sawResolverFailure) return "unknown";
  // Exchanges beyond the cutoff were never probed, so their domain cannot be
  // asserted dead; only a fully probed list earns "undeliverable".
  return exchanges.length > MAX_EXCHANGES_PROBED ? "unknown" : "undeliverable";
}

/** RFC 1035 §2.3.4 caps a domain name at 253 octets; nothing longer resolves. */
const MAX_DOMAIN_OCTETS = 253;

/**
 * Map a domain to its A-label (ASCII) form.
 *
 * The DoH endpoint rejects raw U-labels with HTTP 400, so probing an
 * internationalized domain verbatim would silently skip the gate. WHATWG `URL`
 * performs the IDNA ToASCII mapping on every supported runtime.
 *
 * @param domain - Lowercased domain part of an address.
 * @returns The A-label form, or `null` when the domain cannot be mapped.
 */
function toAsciiDomain(domain: string): string | null {
  if (/^[\x00-\x7f]+$/.test(domain)) return domain;
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Extract the probe-ready domain from an email address.
 *
 * Bounds the domain and nothing else. The local part can be padded to any
 * length and Better Auth's validator accepts it, so an address-length guard in
 * front of the probe would be a gate bypass; the limit belongs on the domain,
 * which is the only part that has to resolve. Applied to the A-label form,
 * because that is what goes on the wire.
 *
 * A `null` result skips the probe and leaves the verdict to Better Auth's own
 * validation.
 *
 * @param email - Address to split.
 * @returns The lowercased A-label domain, or `null` when the address has no
 *   single `@` separator, an empty domain part, an unmappable domain, or a
 *   domain past {@link MAX_DOMAIN_OCTETS}.
 */
export function recipientDomain(email: string): string | null {
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) return null;
  const domain = parts[1];
  if (domain.length === 0) return null;
  const ascii = toAsciiDomain(domain);
  if (ascii === null) return null;
  return ascii.length <= MAX_DOMAIN_OCTETS ? ascii : null;
}
