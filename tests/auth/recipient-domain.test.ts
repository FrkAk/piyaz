import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  checkRecipientDomain,
  recipientDomain,
  setRecipientDomainResolver,
} from "@/lib/auth/recipient-domain";

/** One canned DoH answer set, keyed by `"<name>:<type>"`. */
type Zone = Record<string, { Status?: number; Answer?: unknown[] } | "fail">;

const realFetch = globalThis.fetch;

/**
 * Install a fake DoH resolver serving `zone`. Any name/type absent from the
 * zone answers NOERROR with no records, matching a real NODATA response.
 *
 * @param zone - Canned answers keyed by `"<name>:<type>"`.
 */
function stubResolver(zone: Zone): void {
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    const key = `${url.searchParams.get("name")}:${url.searchParams.get("type")}`;
    const entry = zone[key];
    if (entry === "fail") throw new Error("resolver unreachable");
    return new Response(JSON.stringify(entry ?? { Status: 0, Answer: [] }), {
      status: 200,
      headers: { "content-type": "application/dns-json" },
    });
  }) as typeof fetch;
}

/**
 * Build an answer record in the DoH JSON shape.
 *
 * @param type - Numeric record type.
 * @param data - Record data string.
 * @returns One answer entry.
 */
function answer(type: number, data: string) {
  return { type, data };
}

// These exercise the live DoH probe itself, so they lift the hermetic
// resolver `tests/setup/preload.ts` installs and stub `fetch` instead. The
// default goes back on afterwards so later files stay off the network.
beforeEach(() => {
  setRecipientDomainResolver(null);
  stubResolver({});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRecipientDomainResolver(async () => "deliverable");
});

test("domain with a resolvable MX exchange is deliverable", async () => {
  stubResolver({
    "example.com:15": { Status: 0, Answer: [answer(15, "10 mx.example.com.")] },
    "mx.example.com:1": { Status: 0, Answer: [answer(1, "203.0.113.10")] },
  });
  expect(await checkRecipientDomain("example.com")).toBe("deliverable");
});

test("MX resolving only to loopback is undeliverable", async () => {
  // The exchange DOES resolve, but to 127.0.0.1, which no public sender can
  // connect to. Parked and anti-spam domains point MX at loopback deliberately
  // so mail dies; Cloudflare reports the result as `transport_none`. Treating
  // "resolves" as "deliverable" misses this entire class.
  stubResolver({
    "parked.example:15": {
      Status: 0,
      Answer: [answer(15, "10 localhost.parked.example.")],
    },
    "localhost.parked.example:1": {
      Status: 0,
      Answer: [answer(1, "127.0.0.1")],
    },
    "localhost.parked.example:28": { Status: 0, Answer: [] },
  });
  expect(await checkRecipientDomain("parked.example")).toBe("undeliverable");
});

test("MX pointing at a host with no address record is undeliverable", async () => {
  stubResolver({
    "nomx.example:15": {
      Status: 0,
      Answer: [answer(15, "10 gone.nomx.example.")],
    },
    "gone.nomx.example:1": { Status: 0, Answer: [] },
    "gone.nomx.example:28": { Status: 0, Answer: [] },
  });
  expect(await checkRecipientDomain("nomx.example")).toBe("undeliverable");
});

test("MX resolving to RFC 1918 private space is undeliverable", async () => {
  stubResolver({
    "priv.example:15": {
      Status: 0,
      Answer: [answer(15, "10 mx.priv.example.")],
    },
    "mx.priv.example:1": { Status: 0, Answer: [answer(1, "10.0.0.5")] },
    "mx.priv.example:28": { Status: 0, Answer: [] },
  });
  expect(await checkRecipientDomain("priv.example")).toBe("undeliverable");
});

test("IPv6 loopback and unique-local exchanges are undeliverable", async () => {
  stubResolver({
    "v6bad.example:15": {
      Status: 0,
      Answer: [answer(15, "10 mx.v6bad.example.")],
    },
    "mx.v6bad.example:1": { Status: 0, Answer: [] },
    "mx.v6bad.example:28": { Status: 0, Answer: [answer(28, "fd00::1")] },
  });
  expect(await checkRecipientDomain("v6bad.example")).toBe("undeliverable");
});

test("RFC 7505 null MX is undeliverable", async () => {
  stubResolver({
    "no-mail.example:15": { Status: 0, Answer: [answer(15, "0 .")] },
    "no-mail.example:1": { Status: 0, Answer: [] },
    "no-mail.example:28": { Status: 0, Answer: [] },
  });
  expect(await checkRecipientDomain("no-mail.example")).toBe("undeliverable");
});

test("no MX falls back to the domain's own address record", async () => {
  stubResolver({
    "implicit.example:15": { Status: 0, Answer: [] },
    "implicit.example:1": { Status: 0, Answer: [answer(1, "203.0.113.20")] },
  });
  expect(await checkRecipientDomain("implicit.example")).toBe("deliverable");
});

test("NXDOMAIN is undeliverable", async () => {
  stubResolver({
    "nope.invalid:15": { Status: 3 },
    "nope.invalid:1": { Status: 3 },
    "nope.invalid:28": { Status: 3 },
  });
  expect(await checkRecipientDomain("nope.invalid")).toBe("undeliverable");
});

test("second exchange rescues a first that does not resolve", async () => {
  stubResolver({
    "two.example:15": {
      Status: 0,
      Answer: [
        answer(15, "10 dead.two.example."),
        answer(15, "20 ok.two.example."),
      ],
    },
    "dead.two.example:1": { Status: 0, Answer: [] },
    "dead.two.example:28": { Status: 0, Answer: [] },
    "ok.two.example:1": { Status: 0, Answer: [answer(1, "203.0.113.30")] },
  });
  expect(await checkRecipientDomain("two.example")).toBe("deliverable");
});

test("AAAA-only exchange is deliverable", async () => {
  stubResolver({
    "v6.example:15": { Status: 0, Answer: [answer(15, "10 mx.v6.example.")] },
    "mx.v6.example:1": { Status: 0, Answer: [] },
    "mx.v6.example:28": { Status: 0, Answer: [answer(28, "2001:db8::1")] },
  });
  expect(await checkRecipientDomain("v6.example")).toBe("deliverable");
});

test("resolver failure fails open as unknown", async () => {
  stubResolver({ "flaky.example:15": "fail" });
  expect(await checkRecipientDomain("flaky.example")).toBe("unknown");
});

test("exchange lookup failure fails open rather than rejecting the domain", async () => {
  stubResolver({
    "flaky2.example:15": {
      Status: 0,
      Answer: [answer(15, "10 mx.flaky2.example.")],
    },
    "mx.flaky2.example:1": "fail",
  });
  expect(await checkRecipientDomain("flaky2.example")).toBe("unknown");
});

test("recipientDomain lowercases and extracts the domain", () => {
  expect(recipientDomain("  User@Example.COM ")).toBe("example.com");
});

test("recipientDomain rejects malformed addresses", () => {
  expect(recipientDomain("no-at-sign")).toBeNull();
  expect(recipientDomain("two@at@signs")).toBeNull();
  expect(recipientDomain("empty@")).toBeNull();
});
