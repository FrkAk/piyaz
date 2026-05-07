import { test, expect } from "bun:test";
import { conditionalRespond } from "@/lib/api/conditional";

test("returns 200 with body and Last-Modified when no If-Modified-Since", async () => {
  const req = new Request("http://test/x");
  const lm = new Date("2026-05-07T10:00:00Z");
  const res = conditionalRespond(req, { ok: 1 }, lm);
  expect(res.status).toBe(200);
  expect(res.headers.get("Last-Modified")).toBe(lm.toUTCString());
  expect(await res.json()).toEqual({ ok: 1 });
});

test("returns 304 with no body when If-Modified-Since at Last-Modified", async () => {
  const lm = new Date("2026-05-07T10:00:00Z");
  const req = new Request("http://test/x", {
    headers: { "If-Modified-Since": lm.toUTCString() },
  });
  const res = conditionalRespond(req, { ok: 1 }, lm);
  expect(res.status).toBe(304);
  expect(res.headers.get("Last-Modified")).toBe(lm.toUTCString());
  expect(await res.text()).toBe("");
});

test("returns 304 with no body when If-Modified-Since after Last-Modified", async () => {
  const lm = new Date("2026-05-07T10:00:00Z");
  const newer = new Date("2026-05-07T11:00:00Z");
  const req = new Request("http://test/x", {
    headers: { "If-Modified-Since": newer.toUTCString() },
  });
  const res = conditionalRespond(req, { ok: 1 }, lm);
  expect(res.status).toBe(304);
});

test("returns 200 when If-Modified-Since older than Last-Modified", async () => {
  const lm = new Date("2026-05-07T10:00:00Z");
  const older = new Date("2026-05-07T09:00:00Z");
  const req = new Request("http://test/x", {
    headers: { "If-Modified-Since": older.toUTCString() },
  });
  const res = conditionalRespond(req, { ok: 1 }, lm);
  expect(res.status).toBe(200);
});

test("returns 304 when sub-second drift would otherwise produce 200", async () => {
  // Postgres microsecond timestamp truncated to seconds in the header.
  const lmMicros = new Date(Date.parse("2026-05-07T10:00:00.123Z"));
  const lmSeconds = new Date(Date.parse("2026-05-07T10:00:00.000Z"));
  const req = new Request("http://test/x", {
    headers: { "If-Modified-Since": lmSeconds.toUTCString() },
  });
  const res = conditionalRespond(req, { ok: 1 }, lmMicros);
  expect(res.status).toBe(304);
});

test("malformed If-Modified-Since falls through to 200", async () => {
  const req = new Request("http://test/x", {
    headers: { "If-Modified-Since": "not a date" },
  });
  const res = conditionalRespond(req, { ok: 1 }, new Date());
  expect(res.status).toBe(200);
});

test("HEAD with no If-Modified-Since returns 200 with no body", async () => {
  const req = new Request("http://test/x", { method: "HEAD" });
  const res = conditionalRespond(req, { ok: 1 }, new Date());
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
  expect(res.headers.get("Last-Modified")).toBeTruthy();
});

test("HEAD with matching If-Modified-Since returns 304 with no body", async () => {
  const lm = new Date("2026-05-07T10:00:00Z");
  const req = new Request("http://test/x", {
    method: "HEAD",
    headers: { "If-Modified-Since": lm.toUTCString() },
  });
  const res = conditionalRespond(req, { ok: 1 }, lm);
  expect(res.status).toBe(304);
  expect(await res.text()).toBe("");
});
