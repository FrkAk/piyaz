import { test, expect } from "bun:test";
import {
  normalizeFolderInput,
  resolveCreateTarget,
} from "@/components/workspace/notes/note-meta";

/**
 * Pure unit tests for the New-note create target and the naming-first
 * folder-name normalization. No DB. Pins the selection precedence the
 * tree pane dispatches on: selected folder wins, then the selected
 * note's folder, then the `Drafts` inbox.
 */

test("resolveCreateTarget prefers the selected folder", () => {
  expect(resolveCreateTarget("Ideas", undefined)).toBe("Ideas");
  expect(resolveCreateTarget("Ideas/Nested", "Other")).toBe("Ideas/Nested");
});

test("resolveCreateTarget falls back to the selected note's folder", () => {
  expect(resolveCreateTarget(null, "Specs")).toBe("Specs");
  expect(resolveCreateTarget(null, "Specs/API")).toBe("Specs/API");
});

test("resolveCreateTarget sends a selected root note to Drafts", () => {
  expect(resolveCreateTarget(null, "")).toBe("Drafts");
});

test("resolveCreateTarget defaults to Drafts with nothing selected", () => {
  expect(resolveCreateTarget(null, undefined)).toBe("Drafts");
});

test("normalizeFolderInput applies the server segment rules", () => {
  expect(normalizeFolderInput("  Ideas  ")).toBe("Ideas");
  expect(normalizeFolderInput(" a / b ")).toBe("a/b");
  expect(normalizeFolderInput("a//b")).toBe("a/b");
  expect(normalizeFolderInput("/a/b/")).toBe("a/b");
  expect(normalizeFolderInput("")).toBe("");
  expect(normalizeFolderInput(" / / ")).toBe("");
});
