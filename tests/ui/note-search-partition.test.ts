import { test, expect } from "bun:test";
import { partitionSearchHits } from "@/components/workspace/notes/note-meta";

/**
 * Build a minimal hit row for the partition.
 *
 * @param sequenceNumber - Note sequence number.
 * @param title - Note title.
 * @param summary - Note summary.
 * @returns Hit shaped for {@link partitionSearchHits}.
 */
function hit(sequenceNumber: number, title: string, summary = "") {
  return { sequenceNumber, title, summary };
}

test("title, summary, and ref-fragment matches are direct; body hits are content", () => {
  const hits = [
    hit(1, "EEVDF: eligibility and virtual deadlines"),
    hit(2, "vruntime and nice weight"),
    hit(3, "Q3", "quarterly EEVDF baseline"),
  ];

  const byTitle = partitionSearchHits(hits, "eevdf", "SCX");
  expect(byTitle.direct.map((h) => h.sequenceNumber)).toEqual([1, 3]);
  expect(byTitle.content.map((h) => h.sequenceNumber)).toEqual([2]);

  const byRef = partitionSearchHits(hits, "N1", "SCX");
  expect(byRef.direct.map((h) => h.sequenceNumber)).toEqual([1]);

  const bare = partitionSearchHits(hits, "1", "SCX");
  expect(bare.direct.map((h) => h.sequenceNumber)).toEqual([1]);
});

test("the split is literal and preserves server order within each group", () => {
  const hits = [hit(1, "100% rollout"), hit(2, "Doc b"), hit(3, "Doc a")];

  const literal = partitionSearchHits(hits, "%", "PRJ");
  expect(literal.direct.map((h) => h.sequenceNumber)).toEqual([1]);

  const ordered = partitionSearchHits(hits, "doc", "PRJ");
  expect(ordered.direct.map((h) => h.sequenceNumber)).toEqual([2, 3]);
  expect(partitionSearchHits(hits, "", "PRJ").direct).toEqual([]);
});
