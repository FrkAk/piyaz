/**
 * Whether an IP address is reachable from the public internet.
 *
 * Used by the sign-up deliverability gate: a domain whose MX resolves only to
 * unreachable space publishes a record no sender can ever connect to, which is
 * what parked and anti-spam domains do on purpose.
 *
 * Containment is numeric, not textual. The same address has many legal
 * spellings (`127.0.0.1`, `::ffff:127.0.0.1`, `::ffff:7f00:1`,
 * `64:ff9b::7f00:1`, `2002:7f00:1::`), and a prefix match over the string form
 * only catches the ones it was written for. Parsing once and testing prefix
 * containment closes that class.
 *
 * No `server-only` import: this is pure arithmetic with no platform surface, so
 * it stays directly testable and usable from either runtime.
 *
 * Sources: IANA IPv4 and IPv6 Special-Purpose Address Registries (the
 * `Globally Reachable` column is exactly this predicate), RFC 6890, and the
 * IPv4/IPv6 multicast registries.
 */

/**
 * IPv4 space that is never a valid public mail target.
 *
 * `240.0.0.0/4` subsumes the limited-broadcast address, and `224.0.0.0/4` is
 * multicast, which lives in its own registry rather than the special-purpose
 * one but is equally never a unicast SMTP peer.
 */
const NON_ROUTABLE_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;

/**
 * IPv6 space that is never a valid public mail target.
 *
 * `::/96` covers the unspecified address, loopback, and the deprecated
 * IPv4-compatible form in one entry. `64:ff9b::/96` and `2002::/16` embed an
 * IPv4 address, so they are rejected wholesale rather than unwrapped: an
 * embedded private or loopback address is unreachable, and an embedded public
 * one still needs a translator or relay that a public MTA has no reason to
 * have. `fec0::/10` is deprecated site-local (RFC 3879), never globally
 * reachable.
 */
const NON_ROUTABLE_V6 = [
  "::/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/32",
  "2001:2::/48",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
] as const;

/** A parsed CIDR range: network bytes plus the significant prefix length. */
interface Range {
  bytes: Uint8Array;
  prefix: number;
}

/**
 * Parse a dotted-quad IPv4 address into its four bytes.
 *
 * @param value - Candidate address, already trimmed and lowercased.
 * @returns The address bytes, or `null` when the value is not a valid IPv4.
 */
function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index];
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    bytes[index] = octet;
  }
  return bytes;
}

/**
 * Rewrite a trailing dotted-quad in an IPv6 literal into two hextets, so the
 * hextet parser sees a uniform shape (`::ffff:1.2.3.4` becomes `::ffff:102:304`).
 *
 * @param value - Candidate IPv6 address.
 * @returns The rewritten literal, or `null` when the trailing quad is invalid.
 */
function foldTrailingIpv4(value: string): string | null {
  if (!value.includes(".")) return value;
  const cut = value.lastIndexOf(":");
  if (cut === -1) return null;
  const quad = parseIpv4(value.slice(cut + 1));
  if (quad === null) return null;
  const high = ((quad[0] << 8) | quad[1]).toString(16);
  const low = ((quad[2] << 8) | quad[3]).toString(16);
  return `${value.slice(0, cut + 1)}${high}:${low}`;
}

/**
 * Expand an IPv6 literal into its eight hextet strings, resolving `::`.
 *
 * @param value - IPv6 literal with any trailing dotted-quad already folded.
 * @returns Exactly eight hextets, or `null` when the literal is malformed.
 */
function expandHextets(value: string): string[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = halves[1] === "" ? [] : halves[1].split(":");
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array<string>(fill).fill("0"), ...tail];
}

/**
 * Parse an IPv6 address into its sixteen bytes.
 *
 * @param value - Candidate address, already trimmed and lowercased.
 * @returns The address bytes, or `null` when the value is not a valid IPv6.
 */
function parseIpv6(value: string): Uint8Array | null {
  const folded = foldTrailingIpv4(value);
  if (folded === null) return null;
  const hextets = expandHextets(folded);
  if (hextets === null) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(hextets[index])) return null;
    const group = Number.parseInt(hextets[index], 16);
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

/**
 * Parse a `network/prefix` string from the tables above.
 *
 * @param entry - CIDR string, IPv4 or IPv6.
 * @returns The parsed range.
 * @throws Error when a table entry is malformed, which is a programming error.
 */
function parseRange(entry: string): Range {
  const [network, width] = entry.split("/");
  const bytes = network.includes(":") ? parseIpv6(network) : parseIpv4(network);
  if (bytes === null) throw new Error(`unparseable range: ${entry}`);
  return { bytes, prefix: Number(width) };
}

const V4_RANGES: Range[] = NON_ROUTABLE_V4.map(parseRange);
const V6_RANGES: Range[] = NON_ROUTABLE_V6.map(parseRange);

/**
 * Whether an address falls inside a CIDR range.
 *
 * @param address - Address bytes, same family as the range.
 * @param range - Network bytes and prefix length.
 * @returns `true` when the address is contained in the range.
 */
function contains(address: Uint8Array, range: Range): boolean {
  let remaining = range.prefix;
  for (let index = 0; index < address.length && remaining > 0; index += 1) {
    const take = remaining >= 8 ? 8 : remaining;
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((address[index] & mask) !== (range.bytes[index] & mask)) return false;
    remaining -= take;
  }
  return true;
}

/**
 * Extract the IPv4 address embedded in an IPv4-mapped IPv6 address
 * (`::ffff:0:0/96`), so it is judged by the IPv4 table.
 *
 * @param bytes - Sixteen IPv6 address bytes.
 * @returns The four embedded IPv4 bytes, or `null` when not IPv4-mapped.
 */
function mappedIpv4(bytes: Uint8Array): Uint8Array | null {
  for (let index = 0; index < 10; index += 1) {
    if (bytes[index] !== 0) return null;
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return bytes.slice(12);
}

/**
 * Whether an address is reachable for mail delivery from the public internet.
 *
 * Fails open on anything unparseable: a malformed resolver answer must degrade
 * to "we cannot tell", never to a rejected sign-up. Only an address that parses
 * *and* falls in special-purpose space is reported unreachable.
 *
 * @param address - An A or AAAA record's data.
 * @returns `true` when the address is publicly routable or cannot be parsed.
 */
export function isPubliclyRoutable(address: string): boolean {
  const value = address.trim().toLowerCase();

  const v4 = parseIpv4(value);
  if (v4 !== null) return !V4_RANGES.some((range) => contains(v4, range));

  const v6 = parseIpv6(value);
  if (v6 === null) return true;

  const mapped = mappedIpv4(v6);
  if (mapped !== null) {
    return !V4_RANGES.some((range) => contains(mapped, range));
  }
  return !V6_RANGES.some((range) => contains(v6, range));
}
