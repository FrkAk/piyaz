import { test, expect } from "bun:test";
import {
  rankLinkSuggestions,
  WIKI_SUGGESTION_CAP,
  type LinkSuggestion,
} from "@/components/workspace/notes/link-suggestions";

/**
 * Build a bare suggestion with only the fields the ranker reads.
 *
 * @param id - Stable candidate id.
 * @param title - Candidate title used for ranking and tie-breaks.
 * @returns A `LinkSuggestion` with placeholder insert/color/hint.
 */
function make(id: string, title: string): LinkSuggestion {
  return { id, title, insert: title, color: "#000", hint: "" };
}

test("exact title beats prefix beats substring", () => {
  const candidates = [
    make("sub", "a design note"),
    make("prefix", "design system"),
    make("exact", "design"),
  ];
  const ranked = rankLinkSuggestions("design", candidates);
  expect(ranked.map((s) => s.id)).toEqual(["exact", "prefix", "sub"]);
});

test("non-matches are dropped", () => {
  const candidates = [make("hit", "auth flow"), make("miss", "billing")];
  const ranked = rankLinkSuggestions("auth", candidates);
  expect(ranked.map((s) => s.id)).toEqual(["hit"]);
});

test("notes and tasks rank in one merged pool", () => {
  const candidates = [
    make("note-1", "Reddit spec"),
    make("task-9", "Reddit OAuth token service"),
  ];
  const ranked = rankLinkSuggestions("reddit oauth", candidates);
  expect(ranked.map((s) => s.id)).toEqual(["task-9"]);
});

test("empty query returns all candidates alphabetically", () => {
  const candidates = [make("b", "Beta"), make("a", "Alpha")];
  const ranked = rankLinkSuggestions("", candidates);
  expect(ranked.map((s) => s.id)).toEqual(["a", "b"]);
});

test("ties break alphabetically by title", () => {
  const candidates = [make("z", "design z"), make("a", "design a")];
  const ranked = rankLinkSuggestions("design", candidates);
  expect(ranked.map((s) => s.id)).toEqual(["a", "z"]);
});

test("result set is capped", () => {
  const candidates = Array.from({ length: WIKI_SUGGESTION_CAP + 10 }, (_, i) =>
    make(`n-${i}`, `note ${String(i).padStart(3, "0")}`),
  );
  const ranked = rankLinkSuggestions("note", candidates);
  expect(ranked).toHaveLength(WIKI_SUGGESTION_CAP);
});
