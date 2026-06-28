import { describe, expect, test } from "bun:test";
import { edgePhrase } from "@/components/workspace/detail/ActivitySection";
import type { ActivityEvent, ActivityEventType } from "@/lib/types";

/** Minimal event — edgePhrase reads only `type` + `summary`. */
function evt(type: ActivityEventType, summary: string): ActivityEvent {
  return { type, summary } as ActivityEvent;
}

// Pins the consumer contract against the summary shapes the edge writer emits
// (lib/data/edge.ts). edgePhrase infers relation kind + direction by parsing the
// stored summary; if either side's wording drifts, these assertions catch it.
describe("edgePhrase", () => {
  const cases: Array<
    [ActivityEventType, string, "depends" | "relates", string]
  > = [
    // depends_on — outgoing (→ target) vs incoming (← source)
    [
      "edge_added",
      "added depends_on → target",
      "depends",
      "added a dependency on",
    ],
    [
      "edge_added",
      "added depends_on ← source",
      "depends",
      "became a dependency of",
    ],
    [
      "edge_removed",
      "removed the depends_on edge → target",
      "depends",
      "removed the dependency on",
    ],
    [
      "edge_removed",
      "removed the depends_on edge ← source",
      "depends",
      "is no longer a dependency of",
    ],
    [
      "edge_updated",
      "updated the depends_on edge → target",
      "depends",
      "updated the dependency on",
    ],
    [
      "edge_updated",
      "updated the depends_on edge ← source",
      "depends",
      "updated the dependency for",
    ],
    // relates_to — symmetric wording across direction
    ["edge_added", "added relates_to → target", "relates", "linked to"],
    ["edge_added", "added relates_to ← source", "relates", "linked to"],
    [
      "edge_removed",
      "removed the relates_to edge → target",
      "relates",
      "removed the link to",
    ],
    [
      "edge_updated",
      "updated the relates_to edge ← source",
      "relates",
      "updated the link to",
    ],
  ];

  for (const [type, summary, kind, text] of cases) {
    test(`${type} "${summary}" → ${kind} "${text}"`, () => {
      const result = edgePhrase(evt(type, summary));
      expect(result.kind).toBe(kind);
      expect(result.text).toBe(text);
    });
  }
});
