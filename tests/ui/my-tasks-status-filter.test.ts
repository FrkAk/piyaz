import { test, expect } from "bun:test";
import {
  DEFAULT_ACTIVE,
  STATUS_OPTIONS,
  countByStatus,
  parseStatusParam,
  serializeStatusSet,
  setsEqual,
} from "@/app/my-tasks/_components/status-filter";

test("parseStatusParam(null) returns the default active set", () => {
  const result = parseStatusParam(null);
  expect(setsEqual(result, DEFAULT_ACTIVE)).toBe(true);
});

test("parseStatusParam('') returns an empty set so the user can deliberately show nothing", () => {
  expect(parseStatusParam("").size).toBe(0);
});

test("parseStatusParam parses a CSV and drops unknown tokens", () => {
  const result = parseStatusParam("draft, bogus ,planned");
  expect(setsEqual(result, new Set(["draft", "planned"]))).toBe(true);
});

test("parseStatusParam handles a single status", () => {
  const result = parseStatusParam("in_review");
  expect(setsEqual(result, new Set(["in_review"]))).toBe(true);
});

test("serializeStatusSet emits canonical lifecycle order regardless of insertion order", () => {
  const reversed = new Set<(typeof STATUS_OPTIONS)[number]>([
    "cancelled",
    "draft",
    "in_progress",
  ]);
  expect(serializeStatusSet(reversed)).toBe("draft,in_progress,cancelled");
});

test("parseStatusParam composed with serializeStatusSet is a round-trip", () => {
  const input = "draft,in_review,done";
  expect(serializeStatusSet(parseStatusParam(input))).toBe(input);
});

test("setsEqual recognises the default active selection", () => {
  expect(
    setsEqual(DEFAULT_ACTIVE, new Set(["planned", "in_progress", "in_review"])),
  ).toBe(true);
  expect(setsEqual(DEFAULT_ACTIVE, new Set(["planned", "in_progress"]))).toBe(
    false,
  );
});

test("countByStatus initialises every lifecycle bucket and tallies rows", () => {
  const rows = [
    { status: "in_progress" as const },
    { status: "in_progress" as const },
    { status: "done" as const },
  ];
  const counts = countByStatus(rows);
  expect(counts.in_progress).toBe(2);
  expect(counts.done).toBe(1);
  expect(counts.draft).toBe(0);
  expect(counts.planned).toBe(0);
  expect(counts.in_review).toBe(0);
  expect(counts.cancelled).toBe(0);
});
