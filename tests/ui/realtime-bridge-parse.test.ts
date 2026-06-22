import { test, expect } from "bun:test";
import { parseSseFrame } from "@/components/providers/RealtimeBridge";

test("parseSseFrame — extracts a single data line", () => {
  expect(parseSseFrame('data: {"kind":"project"}\n\n')).toBe(
    '{"kind":"project"}',
  );
});

test("parseSseFrame — strips CRLF line endings", () => {
  expect(parseSseFrame('data: {"a":1}\r\n\r\n')).toBe('{"a":1}');
});

test("parseSseFrame — joins multi-line data with newline", () => {
  expect(parseSseFrame("data: line1\ndata:line2\n\n")).toBe("line1\nline2");
});

test("parseSseFrame — strips only one leading space per data line", () => {
  expect(parseSseFrame("data:  spaced\n\n")).toBe(" spaced");
});

test("parseSseFrame — comment / heartbeat frames yield null", () => {
  expect(parseSseFrame(": heartbeat\n\n")).toBeNull();
});
