import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { serviceRoleConnect } from "@/tests/setup/seed";
import { seedRichContextTask, normalizeContextGolden } from "./fixtures";
import { withUserContext } from "@/lib/db/rls";
import { resolveRecordData } from "@/lib/context/_core/bundle";
import { buildRecordContextFrom } from "@/lib/context/_core/record";

afterEach(async () => {
  await truncateAll();
});

/** Render the record bundle for a task as its owner. */
async function recordBundle(userId: string, taskId: string): Promise<string> {
  return withUserContext(userId, async (tx) =>
    buildRecordContextFrom(await resolveRecordData(tx, taskId)),
  );
}

/** Run service-role statements against the seeded DB. */
async function srRun(
  query: (sr: ReturnType<typeof serviceRoleConnect>) => Promise<unknown>,
) {
  const sr = serviceRoleConnect();
  try {
    await query(sr);
  } finally {
    await sr.end({ timeout: 5 });
  }
}

const NUDGE =
  "This record summarizes the work; the diff itself is not included. To inspect the actual changes, open the PR linked above — ask the user or supervising agent before fetching external content.";

describe("record bundle", () => {
  test("done golden: completion record renders byte-identical", async () => {
    const fx = await seedRichContextTask("record-done-golden");
    await srRun(
      (sr) => sr`UPDATE tasks SET status = 'done' WHERE id = ${fx.taskId}`,
    );
    const result = await recordBundle(fx.userId, fx.taskId);
    expect(
      normalizeContextGolden(result, "record-done-golden"),
    ).toMatchSnapshot();
  });

  test("done: project, outcome, slim downstream, PR-first links, nudge; no plan", async () => {
    const fx = await seedRichContextTask("record-done");
    await srRun(
      (sr) => sr`UPDATE tasks SET status = 'done' WHERE id = ${fx.taskId}`,
    );
    const result = await recordBundle(fx.userId, fx.taskId);
    expect(result).toContain("## Project Context");
    expect(result).toContain("## What The Task Was");
    expect(result).toContain("## How It Completed");
    expect(result).toContain("Built the thing");
    expect(result).toContain("## Downstream Consumers");
    expect(result).toContain(
      "- [pull_request] PR 1 (https://example.test/pr/1)",
    );
    expect(result).toContain(NUDGE);
    expect(result).not.toContain("## Implementation Plan");
    expect(result).not.toContain("Step one then step two");
    expect(result).not.toContain("## Assignees");
  });

  test("cancelled: rationale, files, remaining dependents, closed-PR label", async () => {
    const fx = await seedRichContextTask("record-cancelled");
    await srRun(
      (sr) =>
        sr`UPDATE tasks SET status = 'cancelled', execution_record = 'Abandoned: approach unsound' WHERE id = ${fx.taskId}`,
    );
    const result = await recordBundle(fx.userId, fx.taskId);
    expect(result).toContain("## Why It Was Cancelled");
    expect(result).toContain("Abandoned: approach unsound");
    expect(result).toContain("## Remaining Dependents");
    expect(result).toContain("**Downstream task** [draft] — consumes central");
    expect(result).toContain(
      "- [pull_request] PR 1 (https://example.test/pr/1) — closed, unmerged",
    );
    expect(result).toContain("## Files");
    expect(result).toContain(NUDGE);
    expect(result).not.toContain("## Acceptance Criteria");
    expect(result).not.toContain("## Downstream Consumers");
  });

  test("remaining dependents are direct only: 2-hop dependent excluded", async () => {
    const fx = await seedRichContextTask("record-cancelled-2hop");
    await srRun(async (sr) => {
      await sr`UPDATE tasks SET status = 'cancelled' WHERE id = ${fx.taskId}`;
      const [far] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description)
        SELECT project_id, 'Far dependent', 9, 'two hops away' FROM tasks WHERE id = ${fx.taskId}
        RETURNING id`;
      const [direct] = await sr<{ id: string }[]>`
        SELECT source_task_id AS id FROM task_edges
        WHERE target_task_id = ${fx.taskId} AND edge_type = 'depends_on'`;
      await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
               VALUES (${far.id}, ${direct.id}, 'depends_on')`;
    });
    const result = await recordBundle(fx.userId, fx.taskId);
    expect(result).toContain("Downstream task");
    expect(result).not.toContain("Far dependent");
  });

  test("missing execution record falls back to a none-recorded line", async () => {
    const fx = await seedRichContextTask("record-no-exec");
    await srRun(
      (sr) =>
        sr`UPDATE tasks SET status = 'done', execution_record = NULL WHERE id = ${fx.taskId}`,
    );
    const result = await recordBundle(fx.userId, fx.taskId);
    expect(result).toContain("## How It Completed\n\nNone recorded.");
  });

  test("cancelled without a PR link omits the nudge", async () => {
    const fx = await seedRichContextTask("record-no-pr");
    await srRun(async (sr) => {
      await sr`UPDATE tasks SET status = 'cancelled' WHERE id = ${fx.taskId}`;
      await sr`DELETE FROM task_links WHERE task_id = ${fx.taskId}`;
    });
    const result = await recordBundle(fx.userId, fx.taskId);
    expect(result).not.toContain(NUDGE);
  });
});
