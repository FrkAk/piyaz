import { test, expect } from "bun:test";
import { isPubliclyRoutable } from "@/lib/auth/ip-routability";

/**
 * Coverage for the public-routability predicate behind the sign-up
 * deliverability gate.
 *
 * A domain that points its MX at an address no public sender can connect to
 * publishes a syntactically valid record that always hard-bounces. Parked and
 * anti-spam domains do this deliberately, and the addresses they use are not
 * only loopback and RFC 1918: the documentation blocks, the reserved 240/4
 * space, and the IPv6 transition prefixes that embed an IPv4 address are all
 * in live use for exactly this.
 *
 * Containment is numeric rather than textual, so an address written in an
 * unusual but legal form (`::ffff:7f00:1` for 127.0.0.1) cannot walk past a
 * prefix match. Each boundary case below pins one edge of one range; those are
 * where an off-by-one silently reopens a whole block.
 */

test("ordinary public addresses are routable", () => {
  expect(isPubliclyRoutable("8.8.8.8")).toBe(true);
  expect(isPubliclyRoutable("142.250.1.26")).toBe(true);
  expect(isPubliclyRoutable("2606:4700:4700::1111")).toBe(true);
});

test("loopback and unspecified are not routable, in every written form", () => {
  expect(isPubliclyRoutable("127.0.0.1")).toBe(false);
  expect(isPubliclyRoutable("0.0.0.0")).toBe(false);
  expect(isPubliclyRoutable("::1")).toBe(false);
  expect(isPubliclyRoutable("::")).toBe(false);
  expect(isPubliclyRoutable("0:0:0:0:0:0:0:1")).toBe(false);
});

test("RFC 1918 private space is not routable, and its neighbours are", () => {
  expect(isPubliclyRoutable("10.0.0.1")).toBe(false);
  expect(isPubliclyRoutable("192.168.1.1")).toBe(false);
  expect(isPubliclyRoutable("172.16.0.0")).toBe(false);
  expect(isPubliclyRoutable("172.31.255.255")).toBe(false);
  // The 172/12 block is the one people write as a regex and get wrong.
  expect(isPubliclyRoutable("172.15.255.255")).toBe(true);
  expect(isPubliclyRoutable("172.32.0.0")).toBe(true);
});

test("CGNAT boundaries hold on both sides", () => {
  expect(isPubliclyRoutable("100.64.0.0")).toBe(false);
  expect(isPubliclyRoutable("100.127.255.255")).toBe(false);
  expect(isPubliclyRoutable("100.63.255.255")).toBe(true);
  expect(isPubliclyRoutable("100.128.0.0")).toBe(true);
});

test("link-local is not routable", () => {
  expect(isPubliclyRoutable("169.254.1.1")).toBe(false);
  expect(isPubliclyRoutable("fe80::1")).toBe(false);
  expect(isPubliclyRoutable("febf::1")).toBe(false);
});

test("documentation blocks are not routable", () => {
  // TEST-NET-1/2/3. These are what a copied example config points MX at.
  expect(isPubliclyRoutable("192.0.2.1")).toBe(false);
  expect(isPubliclyRoutable("198.51.100.1")).toBe(false);
  expect(isPubliclyRoutable("203.0.113.1")).toBe(false);
  expect(isPubliclyRoutable("2001:db8::1")).toBe(false);
  // RFC 9637, allocated 2024; absent from most hand-rolled lists.
  expect(isPubliclyRoutable("3fff::1")).toBe(false);
});

test("reserved, multicast, and broadcast space is not routable", () => {
  expect(isPubliclyRoutable("240.0.0.1")).toBe(false);
  expect(isPubliclyRoutable("255.255.255.255")).toBe(false);
  expect(isPubliclyRoutable("224.0.0.1")).toBe(false);
  expect(isPubliclyRoutable("239.255.255.255")).toBe(false);
  expect(isPubliclyRoutable("ff02::1")).toBe(false);
  expect(isPubliclyRoutable("223.255.255.255")).toBe(true);
});

test("benchmarking, 6to4 relay anycast, and protocol assignment blocks", () => {
  expect(isPubliclyRoutable("198.18.0.1")).toBe(false);
  expect(isPubliclyRoutable("198.19.255.255")).toBe(false);
  expect(isPubliclyRoutable("198.17.255.255")).toBe(true);
  expect(isPubliclyRoutable("198.20.0.0")).toBe(true);
  expect(isPubliclyRoutable("192.88.99.1")).toBe(false);
  expect(isPubliclyRoutable("192.0.0.1")).toBe(false);
  expect(isPubliclyRoutable("192.0.1.1")).toBe(true);
  expect(isPubliclyRoutable("2001:2::1")).toBe(false);
});

test("IPv6 unique-local and deprecated site-local are not routable", () => {
  expect(isPubliclyRoutable("fc00::1")).toBe(false);
  expect(isPubliclyRoutable("fd00::1")).toBe(false);
  expect(isPubliclyRoutable("fec0::1")).toBe(false);
});

test("discard, Teredo, and SRv6 prefixes are not routable", () => {
  expect(isPubliclyRoutable("100::1")).toBe(false);
  expect(isPubliclyRoutable("2001::1")).toBe(false);
  expect(isPubliclyRoutable("5f00::1")).toBe(false);
});

test("IPv4-mapped addresses delegate to the IPv4 table in dotted form", () => {
  expect(isPubliclyRoutable("::ffff:127.0.0.1")).toBe(false);
  expect(isPubliclyRoutable("::ffff:10.0.0.1")).toBe(false);
  expect(isPubliclyRoutable("::ffff:8.8.8.8")).toBe(true);
});

test("IPv4 embedded in hex form cannot walk past the check", () => {
  // The whole reason containment is numeric: these are the same addresses as
  // above, written the way a textual prefix match cannot see.
  expect(isPubliclyRoutable("::ffff:7f00:1")).toBe(false);
  expect(isPubliclyRoutable("::ffff:808:808")).toBe(true);
  // NAT64 and 6to4 both embed an IPv4; the embedded loopback must not pass.
  expect(isPubliclyRoutable("64:ff9b::7f00:1")).toBe(false);
  expect(isPubliclyRoutable("64:ff9b:1::1")).toBe(false);
  expect(isPubliclyRoutable("2002:7f00:1::")).toBe(false);
});

test("case does not change the verdict", () => {
  expect(isPubliclyRoutable("FE80::1")).toBe(false);
  expect(isPubliclyRoutable("2001:DB8::1")).toBe(false);
});

test("an unparseable value is treated as routable, so garbage never rejects", () => {
  // Fail open, matching the probe's contract: a malformed resolver answer must
  // degrade to "we cannot tell", never to a rejected sign-up.
  expect(isPubliclyRoutable("not-an-ip")).toBe(true);
  expect(isPubliclyRoutable("")).toBe(true);
  expect(isPubliclyRoutable("999.1.1.1")).toBe(true);
});
