import { describe, expect, test } from "bun:test";
import { diffTaskChanges } from "@/lib/data/task";
import type { Task } from "@/lib/db/schema";

const base = {
  id: "t-1",
  projectId: "p-1",
  title: "Old",
  status: "draft",
  priority: null,
  estimate: null,
  category: null,
  implementationPlan: null,
  executionRecord: null,
  order: 0,
  tags: ["a"],
  files: [],
} as unknown as Task;

describe("diffTaskChanges", () => {
  test("emits a discrete event per changed scalar", () => {
    const events = diffTaskChanges("p-1", "t-1", base, {
      title: "New",
      status: "done",
    });
    expect(events.map((e) => e.type).sort()).toEqual([
      "status_changed",
      "title_changed",
    ]);
    const status = events.find((e) => e.type === "status_changed")!;
    expect(status.metadata).toEqual({ from: "draft", to: "done" });
  });

  test("emits tag_added / tag_removed per element", () => {
    const events = diffTaskChanges("p-1", "t-1", base, { tags: ["a", "b"] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "tag_added", targetRef: "b" });
  });

  test("returns nothing when values are unchanged", () => {
    expect(diffTaskChanges("p-1", "t-1", base, { title: "Old" })).toEqual([]);
  });
});
