import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedRichContextTask } from "@/tests/context/fixtures";
import { withUserContextRead } from "@/lib/db/rls";
import { normalizeExecuteResult } from "@/lib/db/raw";
import {
  DEPTH_PROJECTIONS,
  taskFieldsStmt,
  type TaskFieldsRawRow,
} from "@/lib/db/raw/fetch-task-full";

afterEach(async () => {
  await truncateAll();
});

test("record depth keeps the retrospective columns and drops the plan", () => {
  expect(DEPTH_PROJECTIONS.record).toEqual({
    tags: true,
    category: true,
    implementationPlan: false,
    executionRecord: true,
    files: false,
    assignees: false,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  });
});

test("agent depth selects assignees (implementer sees ownership)", () => {
  expect(DEPTH_PROJECTIONS.agent.assignees).toBe(true);
});

test("agent depth selects the plan active-only (terminal tasks dispatch to record)", () => {
  expect(DEPTH_PROJECTIONS.agent.implementationPlan).toBe("active-only");
});

test("planning depth selects the execution record (work-so-far section)", () => {
  expect(DEPTH_PROJECTIONS.planning.executionRecord).toBe(true);
});

test("every depth selects category (headers render it)", () => {
  for (const projection of Object.values(DEPTH_PROJECTIONS)) {
    expect(projection.category).toBe(true);
  }
});

test("no depth selects files (bundles point at the PR diff instead)", () => {
  for (const projection of Object.values(DEPTH_PROJECTIONS)) {
    expect(projection.files).toBe(false);
  }
});

test("taskFieldsStmt egresses only the requested columns plus identity", async () => {
  const fx = await seedRichContextTask("fields-stmt");
  const [raw] = await withUserContextRead(fx.userId, (read) => [
    taskFieldsStmt(read, fx.taskId, [
      "implementationPlan",
      "acceptanceCriteria",
    ]),
  ]);
  const [row] = normalizeExecuteResult<TaskFieldsRawRow>(raw);

  expect(row.id).toBe(fx.taskId);
  expect(row.sequence_number).toBe(2);
  expect(row.project_identifier).toContain("PRJ");
  expect(row.updated_at).toBeTruthy();

  expect(row.implementation_plan).toBe("Step one then step two");
  expect(row.acceptance_criteria).toHaveLength(1);

  expect(row.title).toBeNull();
  expect(row.description).toBeNull();
  expect(row.execution_record).toBeNull();
  expect(row.decisions).toBeNull();
  expect(row.links).toBeNull();
  expect(row.assignees).toBeNull();
});

test("taskFieldsStmt returns no row for a foreign caller", async () => {
  const fx = await seedRichContextTask("fields-rls-a");
  const other = await seedRichContextTask("fields-rls-b");
  const [raw] = await withUserContextRead(other.userId, (read) => [
    taskFieldsStmt(read, fx.taskId, ["title"]),
  ]);
  expect(normalizeExecuteResult<TaskFieldsRawRow>(raw)).toHaveLength(0);
});
