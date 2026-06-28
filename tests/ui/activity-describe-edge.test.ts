import { describe, expect, test } from "bun:test";
import { edgePhrase } from "@/components/workspace/detail/ActivitySection";
import type { ActivityEvent, ActivityEventType } from "@/lib/types";

/** Event carrying the `metadata` the edge writer stores (the live contract). */
function evt(
  type: ActivityEventType,
  direction: "outgoing" | "incoming",
  relation: "depends_on" | "relates_to",
): ActivityEvent {
  return {
    type,
    metadata: { direction, relation },
  } as unknown as ActivityEvent;
}

/** Legacy/backfilled event with no edge metadata — only a stored summary. */
function legacyEvt(type: ActivityEventType, summary: string): ActivityEvent {
  return { type, summary } as ActivityEvent;
}

// edgePhrase reads metadata.{direction,relation}. These cases mirror exactly
// what lib/data/edge.ts writes (asserted in tests/data/activity-edge.test.ts),
// so the writer and consumer are pinned to the same contract.
describe("edgePhrase from metadata", () => {
  const cases: Array<
    [
      ActivityEventType,
      "outgoing" | "incoming",
      "depends_on" | "relates_to",
      "depends" | "relates",
      string,
    ]
  > = [
    // depends_on — outgoing (dependent) vs incoming (prerequisite)
    [
      "edge_added",
      "outgoing",
      "depends_on",
      "depends",
      "added a dependency on",
    ],
    [
      "edge_added",
      "incoming",
      "depends_on",
      "depends",
      "became a dependency of",
    ],
    [
      "edge_removed",
      "outgoing",
      "depends_on",
      "depends",
      "removed the dependency on",
    ],
    [
      "edge_removed",
      "incoming",
      "depends_on",
      "depends",
      "is no longer a dependency of",
    ],
    [
      "edge_updated",
      "outgoing",
      "depends_on",
      "depends",
      "updated the dependency on",
    ],
    [
      "edge_updated",
      "incoming",
      "depends_on",
      "depends",
      "updated the dependency for",
    ],
    // relates_to — symmetric wording across direction
    ["edge_added", "outgoing", "relates_to", "relates", "linked to"],
    ["edge_added", "incoming", "relates_to", "relates", "linked to"],
    [
      "edge_removed",
      "outgoing",
      "relates_to",
      "relates",
      "removed the link to",
    ],
    [
      "edge_updated",
      "incoming",
      "relates_to",
      "relates",
      "updated the link to",
    ],
  ];

  for (const [type, direction, relation, kind, text] of cases) {
    test(`${type} ${direction} ${relation} → ${kind} "${text}"`, () => {
      const result = edgePhrase(evt(type, direction, relation));
      expect(result.kind).toBe(kind);
      expect(result.text).toBe(text);
    });
  }
});

// Backfilled rows carry no edge metadata; edgePhrase must still classify them
// by parsing the stored summary markers (`← source`, `relates_to`).
describe("edgePhrase legacy summary fallback", () => {
  const cases: Array<
    [ActivityEventType, string, "depends" | "relates", string]
  > = [
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
    ["edge_added", "added relates_to → target", "relates", "linked to"],
  ];

  for (const [type, summary, kind, text] of cases) {
    test(`legacy ${type} "${summary}" → ${kind} "${text}"`, () => {
      const result = edgePhrase(legacyEvt(type, summary));
      expect(result.kind).toBe(kind);
      expect(result.text).toBe(text);
    });
  }
});
