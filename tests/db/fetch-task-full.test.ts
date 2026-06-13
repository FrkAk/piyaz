import { expect, test } from "bun:test";
import { DEPTH_PROJECTIONS } from "@/lib/db/raw/fetch-task-full";

test("record depth keeps the retrospective columns and drops the plan", () => {
  expect(DEPTH_PROJECTIONS.record).toEqual({
    tags: true,
    implementationPlan: false,
    executionRecord: true,
    files: false,
    assignees: false,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  });
});

test("agent depth drops assignees (bundle no longer renders them)", () => {
  expect(DEPTH_PROJECTIONS.agent.assignees).toBe(false);
});

test("agent depth selects the plan active-only (terminal tasks dispatch to record)", () => {
  expect(DEPTH_PROJECTIONS.agent.implementationPlan).toBe("active-only");
});

test("no depth selects files (bundles point at the PR diff instead)", () => {
  for (const projection of Object.values(DEPTH_PROJECTIONS)) {
    expect(projection.files).toBe(false);
  }
});
