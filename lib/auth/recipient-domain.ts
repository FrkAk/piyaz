import "server-only";

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

/**
 * How many MX exchanges to resolve before giving up. Mail is delivered to the
 * lowest-preference reachable host, so a domain whose top two exchanges both
 * fail to resolve is treated as undeliverable rather than paying a lookup per
 * record on a domain that publishes a long list.
 */
const MAX_EXCHANGES_PROBED = 2;

/** Abort budget for a single DoH lookup, in milliseconds. */
const LOOKUP_TIMEOUT_MS = 2000;

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
 * @returns Parsed answer data strings, or `null` when the lookup itself failed
 *   (network error, timeout, non-200, SERVFAIL) as opposed to returning no
 *   records.
 */
async function resolve(name: string, type: number): Promise<string[] | null> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as DohResponse;
    if (body.Status !== RCODE_NOERROR) {
      // NXDOMAIN and friends are authoritative "no such name" answers, not
      // resolver failures, so they resolve to an empty record set.
      return [];
    }
    return (body.Answer ?? [])
      .filter((answer) => answer.type === type)
      .map((answer) => answer.data ?? "")
      .filter((data) => data.length > 0);
  } catch {
    return null;
  }
}

/**
 * IPv4 ranges no public mail server can deliver to: loopback, "this host",
 * RFC 1918 private space, link-local, and CGNAT.
 * Sources: RFC 5735, RFC 6598, RFC 6890.
 */
const NON_ROUTABLE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/**
 * Whether an address is reachable for mail delivery from the public internet.
 *
 * A domain that points its MX at a non-routable address publishes a syntactically
 * valid record that no sender can ever connect to. This is the shape behind
 * Cloudflare's `transport_none` failure, and it is deliberate: parked and
 * anti-spam domains point their MX at loopback precisely so mail dies.
 *
 * @param address - An A or AAAA record's data.
 * @returns `true` when the address is publicly routable.
 */
function isRoutable(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (value.includes(":")) {
    // IPv6: unspecified, loopback, link-local (fe80::/10), unique-local (fc00::/7).
    if (value === "::" || value === "::1") return false;
    return !/^(fe[89ab]|f[cd])/.test(value);
  }
  return !NON_ROUTABLE_V4.some((range) => range.test(value));
}

/**
 * Whether a name resolves to at least one publicly routable address.
 *
 * @param name - Host name to resolve.
 * @returns `true` when a routable A or AAAA record exists, `false` when the
 *   name has no address records or only non-routable ones, `null` when the
 *   lookups failed.
 */
async function hasRoutableAddress(name: string): Promise<boolean | null> {
  const a = await resolve(name, RECORD_TYPE.A);
  if (a === null) return null;
  if (a.some(isRoutable)) return true;
  const aaaa = await resolve(name, RECORD_TYPE.AAAA);
  if (aaaa === null) return null;
  return aaaa.some(isRoutable);
}

/**
 * Parse the exchange host out of a DoH MX answer (`"10 mx1.example.com."`).
 *
 * @param data - Raw MX answer data.
 * @returns The exchange host without its trailing dot, or `null` for RFC 7505
 *   null MX (`"0 ."`) and unparseable records.
 */
function parseExchange(data: string): string | null {
  const exchange = data.trim().split(/\s+/)[1];
  if (exchange === undefined) return null;
  const host = exchange.replace(/\.$/, "");
  return host.length > 0 ? host : null;
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

  const mx = await resolve(domain, RECORD_TYPE.MX);
  if (mx === null) return "unknown";

  const exchanges = mx
    .map(parseExchange)
    .filter((host): host is string => host !== null);

  if (mx.length === 0) {
    // No MX at all: RFC 5321 falls back to the domain's own address records.
    const implicit = await hasRoutableAddress(domain);
    if (implicit === null) return "unknown";
    return implicit ? "deliverable" : "undeliverable";
  }

  if (exchanges.length === 0) {
    // MX records exist but none is a usable exchange: RFC 7505 null MX
    // (`0 .`) declares the domain refuses mail, and RFC 7505 §3 forbids the
    // A/AAAA fallback in that case, even when the domain hosts a website.
    return "undeliverable";
  }

  let sawResolverFailure = false;
  for (const exchange of exchanges.slice(0, MAX_EXCHANGES_PROBED)) {
    const reachable = await hasRoutableAddress(exchange);
    if (reachable === null) {
      sawResolverFailure = true;
      continue;
    }
    if (reachable) return "deliverable";
  }
  return sawResolverFailure ? "unknown" : "undeliverable";
}

/**
 * Extract the domain from an email address.
 *
 * @param email - Address to split.
 * @returns The lowercased domain, or `null` when the address has no single `@`
 *   separator or an empty domain part.
 */
export function recipientDomain(email: string): string | null {
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) return null;
  const domain = parts[1];
  return domain.length > 0 ? domain : null;
}
