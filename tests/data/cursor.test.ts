import { test, expect } from "bun:test";
import { decodeCursor, encodeCursor } from "@/lib/data/cursor";

test("decodeCursor round-trips a valid cursor", () => {
  const value = { updatedAt: new Date("2026-01-02T03:04:05.000Z"), id: "abc" };
  const decoded = decodeCursor(encodeCursor(value));
  expect(decoded?.id).toBe("abc");
  expect(decoded?.updatedAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
});

test("decodeCursor returns null for null, undefined, and empty input", () => {
  expect(decodeCursor(null)).toBeNull();
  expect(decodeCursor(undefined)).toBeNull();
  expect(decodeCursor("")).toBeNull();
});

test("decodeCursor returns null for a non-base64 / non-JSON string", () => {
  expect(decodeCursor("not-a-cursor!!!")).toBeNull();
});

test("decodeCursor returns null when the encoded timestamp is not a valid date", () => {
  const crafted = Buffer.from(
    JSON.stringify({ u: "not-a-date", i: "x" }),
    "utf8",
  ).toString("base64url");
  expect(decodeCursor(crafted)).toBeNull();
});
