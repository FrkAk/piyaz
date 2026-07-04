import { test, expect } from "bun:test";
import {
  decodeCursor,
  decodeOrderCursor,
  encodeCursor,
  encodeOrderCursor,
} from "@/lib/data/cursor";

test("decodeCursor round-trips a valid cursor", () => {
  const id = crypto.randomUUID();
  const value = { updatedAt: new Date("2026-01-02T03:04:05.000Z"), id };
  const decoded = decodeCursor(encodeCursor(value));
  expect(decoded?.id).toBe(id);
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
    JSON.stringify({ u: "not-a-date", i: crypto.randomUUID() }),
    "utf8",
  ).toString("base64url");
  expect(decodeCursor(crafted)).toBeNull();
});

test("forged cursor ids degrade to first page instead of a uuid cast error", () => {
  const forged = Buffer.from(
    JSON.stringify({ u: "2026-01-01T00:00:00.000Z", i: "1 OR 1=1" }),
    "utf8",
  ).toString("base64url");
  expect(decodeCursor(forged)).toBeNull();
});

test("order cursor round-trips and rejects forged ids", () => {
  const id = crypto.randomUUID();
  expect(decodeOrderCursor(encodeOrderCursor({ order: 3, id }))).toEqual({
    order: 3,
    id,
  });
  const forged = Buffer.from(
    JSON.stringify({ o: 1, i: "not-a-uuid" }),
    "utf8",
  ).toString("base64url");
  expect(decodeOrderCursor(forged)).toBeNull();
});
