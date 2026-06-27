import { describe, expect, test } from "bun:test";
import {
  diffCriteria,
  diffDecisions,
  diffAssignees,
} from "@/lib/data/activity";

const b = { projectId: "p-1", taskId: "t-1" };

describe("collection diffs", () => {
  test("criteria add + check", () => {
    const before = [{ id: "c1", text: "x", checked: false }];
    const after = [
      { id: "c1", text: "x", checked: true },
      { id: "c2", text: "y", checked: false },
    ];
    const events = diffCriteria(b.projectId, b.taskId, before, after);
    expect(events.map((e) => e.type).sort()).toEqual([
      "criterion_added",
      "criterion_checked",
    ]);
  });

  test("criterion text edit (same id) emits criterion_edited", () => {
    const before = [{ id: "c1", text: "old wording", checked: false }];
    const after = [{ id: "c1", text: "new wording", checked: false }];
    const events = diffCriteria(b.projectId, b.taskId, before, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "criterion_edited",
      targetRef: "c1",
    });
  });

  test("decision text edit (same id) emits decision_edited", () => {
    const before = [{ id: "d1", text: "old wording" }];
    const after = [{ id: "d1", text: "new wording" }];
    const events = diffDecisions(b.projectId, b.taskId, before, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "decision_edited",
      targetRef: "d1",
    });
  });

  test("decisions remove", () => {
    const before = [
      { id: "d1", text: "keep" },
      { id: "d2", text: "drop" },
    ];
    const after = [{ id: "d1", text: "keep" }];
    const events = diffDecisions(b.projectId, b.taskId, before, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "decision_removed" });
  });

  test("assignees add + remove", () => {
    const events = diffAssignees(b.projectId, b.taskId, ["u1"], ["u2"]);
    expect(events.map((e) => e.type).sort()).toEqual([
      "assignee_added",
      "assignee_removed",
    ]);
  });
});
