import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  checkRecipientDomain,
  recipientDomain,
  setRecipientDomainResolver,
  VERDICT_CACHE_TTL_SECONDS,
  __resetDeliverabilityCacheForTest,
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
  __resetDeliverabilityCacheForTest();
  stubResolver({});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setRecipientDomainResolver(async () => "deliverable");
});

test("domain with a resolvable MX exchange is deliverable", async () => {
  stubResolver({
    "example.com:15": { Status: 0, Answer: [answer(15, "10 mx.example.com.")] },
    "mx.example.com:1": { Status: 0, Answer: [answer(1, "93.184.215.14")] },
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

test("link-local and CGNAT exchanges are undeliverable", async () => {
  stubResolver({
    "ll.example:15": { Status: 0, Answer: [answer(15, "10 mx.ll.example.")] },
    "mx.ll.example:1": { Status: 0, Answer: [answer(1, "169.254.10.1")] },
    "mx.ll.example:28": { Status: 0, Answer: [] },
    "cgn.example:15": { Status: 0, Answer: [answer(15, "10 mx.cgn.example.")] },
    "mx.cgn.example:1": { Status: 0, Answer: [answer(1, "100.64.0.1")] },
    "mx.cgn.example:28": { Status: 0, Answer: [] },
  });
  expect(await checkRecipientDomain("ll.example")).toBe("undeliverable");
  expect(await checkRecipientDomain("cgn.example")).toBe("undeliverable");
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

test("RFC 7505 null MX is undeliverable even when the domain itself resolves", async () => {
  // The common real-world shape: a corporate domain hosts a website (routable
  // A record) and publishes `0 .` to declare it receives no mail. RFC 7505 §3
  // defines that encoding; RFC 5321 §5.1 is what forbids falling back to the
  // address records ("If MX records are present, but none of them are usable,
  // this situation MUST be reported as an error"), so the site's own address
  // must not rescue the domain.
  stubResolver({
    "no-mail.example:15": { Status: 0, Answer: [answer(15, "0 .")] },
    "no-mail.example:1": { Status: 0, Answer: [answer(1, "93.184.215.44")] },
    "no-mail.example:28": { Status: 0, Answer: [] },
  });
  expect(await checkRecipientDomain("no-mail.example")).toBe("undeliverable");
});

test("MX answers that do not parse fail open, unlike a null MX", async () => {
  // The discriminator the null-MX case above cannot provide on its own: both
  // land on an empty exchange list, so without this a parser regression that
  // dropped every real MX would read as "this domain refuses mail" and reject
  // every sign-up on it, while the null-MX test stayed green.
  stubResolver({
    "garbled.example:15": {
      Status: 0,
      Answer: [answer(15, "no-preference-no-exchange")],
    },
  });
  expect(await checkRecipientDomain("garbled.example")).toBe("unknown");
});

test("no MX falls back to the domain's own address record", async () => {
  stubResolver({
    "implicit.example:15": { Status: 0, Answer: [] },
    "implicit.example:1": { Status: 0, Answer: [answer(1, "93.184.215.24")] },
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

test("SERVFAIL fails open as unknown, not as no-such-name", async () => {
  // A DNSSEC signing error or unreachable authoritative servers answer
  // Status 2 with HTTP 200. Treating that as an empty record set would
  // hard-reject every user on the domain for the duration of the outage.
  stubResolver({ "dnssec-broken.example:15": { Status: 2 } });
  expect(await checkRecipientDomain("dnssec-broken.example")).toBe("unknown");
});

test("a non-200 DoH response fails open as unknown", async () => {
  globalThis.fetch = (async () =>
    new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
  expect(await checkRecipientDomain("throttled.example")).toBe("unknown");
});

test("exchanges are probed in preference order, not answer order", async () => {
  // The live exchange has the lowest preference but arrives last in the
  // answer. Probing answer order would spend both probe slots on the dead
  // exchanges and reject the domain.
  stubResolver({
    "pref.example:15": {
      Status: 0,
      Answer: [
        answer(15, "20 dead-a.pref.example."),
        answer(15, "30 dead-b.pref.example."),
        answer(15, "10 live.pref.example."),
      ],
    },
    "dead-a.pref.example:1": { Status: 0, Answer: [] },
    "dead-a.pref.example:28": { Status: 0, Answer: [] },
    "dead-b.pref.example:1": { Status: 0, Answer: [] },
    "dead-b.pref.example:28": { Status: 0, Answer: [] },
    "live.pref.example:1": { Status: 0, Answer: [answer(1, "93.184.215.54")] },
  });
  expect(await checkRecipientDomain("pref.example")).toBe("deliverable");
});

test("a truncated exchange list without a routable hit fails open", async () => {
  // Three exchanges, cutoff probes two, both dead; the third was never
  // examined, so the domain cannot be asserted dead.
  stubResolver({
    "long.example:15": {
      Status: 0,
      Answer: [
        answer(15, "10 dead-a.long.example."),
        answer(15, "20 dead-b.long.example."),
        answer(15, "30 unprobed.long.example."),
      ],
    },
    "dead-a.long.example:1": { Status: 0, Answer: [] },
    "dead-a.long.example:28": { Status: 0, Answer: [] },
    "dead-b.long.example:1": { Status: 0, Answer: [] },
    "dead-b.long.example:28": { Status: 0, Answer: [] },
  });
  expect(await checkRecipientDomain("long.example")).toBe("unknown");
});

test("IPv4-mapped and uncompressed IPv6 loopback are non-routable", async () => {
  stubResolver({
    "mapped.example:15": {
      Status: 0,
      Answer: [answer(15, "10 mx.mapped.example.")],
    },
    "mx.mapped.example:1": { Status: 0, Answer: [] },
    "mx.mapped.example:28": {
      Status: 0,
      Answer: [answer(28, "::ffff:127.0.0.1")],
    },
    "longform.example:15": {
      Status: 0,
      Answer: [answer(15, "10 mx.longform.example.")],
    },
    "mx.longform.example:1": { Status: 0, Answer: [] },
    "mx.longform.example:28": {
      Status: 0,
      Answer: [answer(28, "0:0:0:0:0:0:0:1")],
    },
  });
  expect(await checkRecipientDomain("mapped.example")).toBe("undeliverable");
  expect(await checkRecipientDomain("longform.example")).toBe("undeliverable");
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
    "ok.two.example:1": { Status: 0, Answer: [answer(1, "93.184.215.34")] },
  });
  expect(await checkRecipientDomain("two.example")).toBe("deliverable");
});

test("AAAA-only exchange is deliverable", async () => {
  stubResolver({
    "v6.example:15": { Status: 0, Answer: [answer(15, "10 mx.v6.example.")] },
    "mx.v6.example:1": { Status: 0, Answer: [] },
    "mx.v6.example:28": {
      Status: 0,
      Answer: [answer(28, "2606:4700:4700::1111")],
    },
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

test("recipientDomain maps internationalized domains to their A-label", () => {
  // The DoH endpoint rejects raw U-labels with HTTP 400; only the punycoded
  // form is probeable.
  expect(recipientDomain("user@ПрИмЕр.рф")).toBe("xn--e1afmkfd.xn--p1ai");
});

test("recipientDomain fails open on an unmappable non-ASCII domain", () => {
  expect(recipientDomain("user@bad domain.рф")).toBeNull();
});

test("recipientDomain rejects a domain past the RFC 1035 length limit", () => {
  // The guard belongs here, not at the call site: nothing longer than 253
  // octets can resolve, and a second caller must not be able to lose the
  // bound. Bounds the domain only: the local part can be padded to any
  // length, so an address-length guard would be a gate bypass.
  const tooLong = `${"a".repeat(250)}.example.com`;
  expect(tooLong.length).toBeGreaterThan(253);
  expect(recipientDomain(`user@${tooLong}`)).toBeNull();
  expect(recipientDomain(`user@${"a".repeat(240)}.com`)).not.toBeNull();
});

test("the two address families for one exchange are resolved concurrently", async () => {
  // The chain is MX, then A, then AAAA, per exchange. Serialised, a domain
  // whose first exchange is dead costs five round trips and overruns the
  // whole-probe deadline, so a slow but perfectly good domain returns
  // `unknown` and the gate silently stops applying. Overlapping the two
  // families halves the worst case.
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    const key = `${url.searchParams.get("name")}:${url.searchParams.get("type")}`;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    const body =
      key === "slow.example:15"
        ? { Status: 0, Answer: [answer(15, "10 mx.slow.example.")] }
        : key === "mx.slow.example:28"
          ? { Status: 0, Answer: [answer(28, "2606:4700:4700::1111")] }
          : { Status: 0, Answer: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  expect(await checkRecipientDomain("slow.example")).toBe("deliverable");
  expect(peak).toBeGreaterThan(1);
});

test("a routable AAAA still wins when the A lookup itself fails", async () => {
  // Serialised, an A-lookup fault short-circuits to `unknown` and the AAAA
  // record is never consulted, so a v6-reachable exchange reads as unprobeable.
  stubResolver({
    "v6only.example:15": {
      Status: 0,
      Answer: [answer(15, "10 mx.v6only.example.")],
    },
    "mx.v6only.example:1": "fail",
    "mx.v6only.example:28": {
      Status: 0,
      Answer: [answer(28, "2606:4700:4700::1111")],
    },
  });
  expect(await checkRecipientDomain("v6only.example")).toBe("deliverable");
});

test("a repeated probe for the same domain issues no further lookups", async () => {
  // Every probe costs three DoH round trips now that both address families are
  // resolved together, and sign-ups concentrate on a short list of domains.
  let lookups = 0;
  const zone = {
    "memo.example:15": {
      Status: 0,
      Answer: [answer(15, "10 mx.memo.example.")],
    },
    "mx.memo.example:1": { Status: 0, Answer: [answer(1, "93.184.215.14")] },
  };
  globalThis.fetch = (async (input: string | URL) => {
    lookups += 1;
    const url = new URL(String(input));
    const key = `${url.searchParams.get("name")}:${url.searchParams.get("type")}`;
    const entry = (zone as Record<string, unknown>)[key];
    return new Response(JSON.stringify(entry ?? { Status: 0, Answer: [] }), {
      status: 200,
    });
  }) as typeof fetch;

  expect(await checkRecipientDomain("memo.example")).toBe("deliverable");
  const afterFirst = lookups;
  expect(afterFirst).toBeGreaterThan(0);

  expect(await checkRecipientDomain("memo.example")).toBe("deliverable");
  expect(lookups).toBe(afterFirst);
});

test("an unknown verdict is never memoized", async () => {
  // Caching a resolver fault would extend a transient outage for the whole TTL.
  let lookups = 0;
  globalThis.fetch = (async () => {
    lookups += 1;
    return new Response("nope", { status: 500 });
  }) as unknown as typeof fetch;

  expect(await checkRecipientDomain("flap.example")).toBe("unknown");
  const afterFirst = lookups;
  expect(await checkRecipientDomain("flap.example")).toBe("unknown");
  expect(lookups).toBeGreaterThan(afterFirst);
});

test("an undeliverable verdict is held for less time than a deliverable one", () => {
  // A domain that fixes its MX must not stay rejected for the long TTL.
  expect(VERDICT_CACHE_TTL_SECONDS.undeliverable).toBeLessThan(
    VERDICT_CACHE_TTL_SECONDS.deliverable,
  );
});
