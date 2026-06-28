import { describe, expect, test } from "bun:test";
import { diffTaskChanges } from "@/lib/data/task";

type DiffCurrent = Parameters<typeof diffTaskChanges>[2];
type DiffChanges = Parameters<typeof diffTaskChanges>[3];

describe("diffTaskChanges from/to metadata", () => {
  test("status, priority, and estimate carry before/after", () => {
    const current = {
      status: "draft",
      priority: "core",
      estimate: 2,
    } as DiffCurrent;
    const changes = {
      status: "done",
      priority: "urgent",
      estimate: 3,
    } as DiffChanges;

    const events = diffTaskChanges("p", "t", current, changes);
    const byType = (type: string) => events.find((e) => e.type === type);

    expect(byType("status_changed")?.metadata).toEqual({
      from: "draft",
      to: "done",
    });
    expect(byType("priority_changed")?.metadata).toEqual({
      from: "core",
      to: "urgent",
    });
    expect(byType("estimate_changed")?.metadata).toEqual({ from: 2, to: 3 });
  });

  test("category change carries before/after", () => {
    const current = { category: "platform" } as DiffCurrent;
    const changes = { category: "app-shell" } as DiffChanges;

    const events = diffTaskChanges("p", "t", current, changes);
    expect(events.find((e) => e.type === "category_changed")?.metadata).toEqual(
      {
        from: "platform",
        to: "app-shell",
      },
    );
  });
});
