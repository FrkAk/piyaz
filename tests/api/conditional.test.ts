import { test, expect } from "bun:test";
import {
  conditionalRespond,
  etagMatches,
  makeEtag,
} from "@/lib/api/conditional";

test("returns 200 with body and ETag when no If-None-Match", async () => {
  const req = new Request("http://test/x");
  const updatedAt = new Date("2026-05-07T10:00:00Z");
  const res = conditionalRespond(req, { ok: 1 }, updatedAt);
  expect(res.status).toBe(200);
  expect(res.headers.get("ETag")).toBe(makeEtag(updatedAt));
  expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
  expect(await res.json()).toEqual({ ok: 1 });
});

test("returns 304 with no body when If-None-Match equals current ETag", async () => {
  const updatedAt = new Date("2026-05-07T10:00:00Z");
  const etag = makeEtag(updatedAt);
  const req = new Request("http://test/x", {
    headers: { "If-None-Match": etag },
  });
  const res = conditionalRespond(req, { ok: 1 }, updatedAt);
  expect(res.status).toBe(304);
  expect(res.headers.get("ETag")).toBe(etag);
  expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
  expect(await res.text()).toBe("");
});

test("etagMatches mirrors the conditionalRespond branch", () => {
  const updatedAt = new Date("2026-05-07T10:00:00Z");

  const fresh = new Request("http://test/x");
  expect(etagMatches(fresh, updatedAt)).toBe(false);

  const matching = new Request("http://test/x", {
    headers: { "If-None-Match": makeEtag(updatedAt) },
  });
  expect(etagMatches(matching, updatedAt)).toBe(true);

  const older = new Request("http://test/x", {
    headers: { "If-None-Match": makeEtag(new Date("2026-05-07T09:00:00Z")) },
  });
  expect(etagMatches(older, updatedAt)).toBe(false);

  const malformed = new Request("http://test/x", {
    headers: { "If-None-Match": "garbage" },
  });
  expect(etagMatches(malformed, updatedAt)).toBe(false);
});

test("etagMatches honours wildcard `*` for any-match probes", () => {
  const updatedAt = new Date("2026-05-07T10:00:00Z");
  const req = new Request("http://test/x", {
    headers: { "If-None-Match": "*" },
  });
  expect(etagMatches(req, updatedAt)).toBe(true);
});

test("etagMatches handles comma-separated If-None-Match lists", () => {
  const updatedAt = new Date("2026-05-07T10:00:00Z");
  const etag = makeEtag(updatedAt);
  const req = new Request("http://test/x", {
    headers: { "If-None-Match": `"old-other-tag", ${etag}, "another"` },
  });
  expect(etagMatches(req, updatedAt)).toBe(true);
});

test("same-second mutation produces a different ETag — no precision collapse", () => {
  // Regression: with `Last-Modified` the round-trip through HTTP-date
  // truncated milliseconds, so two updates within the same wall-clock
  // second collapsed to the same validator and the second one looked
  // 'unchanged'. ETag uses ms-precision so the same shape now produces
  // distinct validators.
  const t0 = new Date("2026-05-07T10:00:00.200Z");
  const t1 = new Date("2026-05-07T10:00:00.800Z");
  expect(makeEtag(t0)).not.toBe(makeEtag(t1));

  const req = new Request("http://test/x", {
    headers: { "If-None-Match": makeEtag(t0) },
  });
  // Resource was updated to t1; client's validator is t0 — must NOT 304.
  expect(etagMatches(req, t1)).toBe(false);
  const res = conditionalRespond(req, { ok: 1 }, t1);
  expect(res.status).toBe(200);
});

test("HEAD with no If-None-Match returns 200 with no body", async () => {
  const req = new Request("http://test/x", { method: "HEAD" });
  const res = conditionalRespond(req, { ok: 1 }, new Date());
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
  expect(res.headers.get("ETag")).toBeTruthy();
});

test("HEAD with matching If-None-Match returns 304 with no body", async () => {
  const updatedAt = new Date("2026-05-07T10:00:00Z");
  const req = new Request("http://test/x", {
    method: "HEAD",
    headers: { "If-None-Match": makeEtag(updatedAt) },
  });
  const res = conditionalRespond(req, { ok: 1 }, updatedAt);
  expect(res.status).toBe(304);
  expect(await res.text()).toBe("");
});
