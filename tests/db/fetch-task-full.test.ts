import { expect, test } from "bun:test";
import { DEPTH_PROJECTIONS } from "@/lib/db/raw/fetch-task-full";

test("record depth keeps the retrospective columns and drops the plan", () => {
  expect(DEPTH_PROJECTIONS.record).toEqual({
    tags: true,
    implementationPlan: false,
    executionRecord: true,
    files: true,
    assignees: false,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  });
});

test("agent depth drops assignees (bundle no longer renders them)", () => {
  expect(DEPTH_PROJECTIONS.agent.assignees).toBe(false);
});
