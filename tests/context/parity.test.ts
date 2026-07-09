import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { serviceRoleConnect } from "@/tests/setup/seed";
import { seedRichContextTask } from "./fixtures";
import {
  resolveDependencyClosure,
  resolvePlanningData,
  resolveRecordData,
  resolveReviewData,
  resolveWorkingData,
} from "@/lib/context/_core/bundle";
import { buildAgentContextParts } from "@/lib/context/_core/agent";
import { buildPlanningContextParts } from "@/lib/context/_core/planning";
import { buildRecordContextParts } from "@/lib/context/_core/record";
import { buildReviewContextParts } from "@/lib/context/_core/review";
import {
  buildWorkingContextFrom,
  formatWorkingContextParts,
} from "@/lib/context/_core/working";
import type {
  BundlePart,
  BundlePartId,
  BundleSectionId,
} from "@/lib/context/parts";
import {
  SECTIONS_BY_BUNDLE,
  type BundleVariant,
} from "@/components/workspace/bundle-tables";

afterEach(async () => {
  await truncateAll();
});

/**
 * Project builder parts onto the drawer-section id sequence, applying the
 * declared parity overrides from the spec (§1):
 * - notice, status-note, and nudge parts are parity-exempt;
 * - the header is exempt except in the agent bundle, where the description
 *   is header-inline and maps onto the drawer `spec` row;
 * - consecutive parts sharing an id collapse to one drawer row (the working
 *   bundle's Meta + Tags + Hierarchy N:1 grouping);
 * - in the agent bundle the drawer renders `blocked` before `spec` even
 *   though the builder emits header(spec) first.
 *
 * @param parts - Builder parts.
 * @param variant - Bundle variant under test.
 * @returns Drawer-section ids in drawer render order.
 */
function drawerOrder(
  parts: BundlePart[],
  variant: BundleVariant,
): BundleSectionId[] {
  const ids: BundleSectionId[] = [];
  for (const part of parts) {
    let id: BundlePartId = part.id;
    if (id === "notice" || id === "nudge" || id === "status-note") continue;
    if (id === "header") {
      if (variant !== "agent") continue;
      id = "spec";
    }
    const sectionId = id as BundleSectionId;
    if (ids[ids.length - 1] !== sectionId) ids.push(sectionId);
  }
  if (variant === "agent") {
    const s = ids.indexOf("spec");
    const b = ids.indexOf("blocked");
    if (s !== -1 && b === s + 1) {
      ids[s] = "blocked";
      ids[b] = "spec";
    }
  }
  return ids;
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

/**
 * Extend the rich fixture so every section of every bundle has data: a
 * cancelled dep with a record (abandoned approaches) and a draft dep
 * (blocked notice for the agent variant).
 *
 * @param suffix - Fixture suffix so seeds don't collide.
 * @returns The central task id and the owner user id.
 */
async function seedFullParityTask(suffix: string) {
  const fx = await seedRichContextTask(suffix);
  await srRun(async (sr) => {
    const [dead] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, description, status, execution_record)
      SELECT project_id, 'Dead approach', 8, 'dropped', 'cancelled', 'Tried Z; failed'
      FROM tasks WHERE id = ${fx.taskId} RETURNING id`;
    const [draftDep] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, description, status)
      SELECT project_id, 'Unfinished dep', 9, 'pending', 'draft'
      FROM tasks WHERE id = ${fx.taskId} RETURNING id`;
    await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type, note)
             VALUES (${fx.taskId}, ${dead.id}, 'depends_on', 'old route'),
                    (${fx.taskId}, ${draftDep.id}, 'depends_on', 'new api')`;
    await sr`INSERT INTO notes (project_id, title, slug, visibility, type, body, summary, feed_mode)
             SELECT project_id, 'House rules', 'house-rules', 'team', 'guidance', 'Rule body.', 'rules', 'all'
             FROM tasks WHERE id = ${fx.taskId}`;
    await sr`INSERT INTO notes (project_id, title, slug, visibility, type, body, summary, feed_mode)
             SELECT project_id, 'Area map', 'area-map', 'team', 'reference', 'Map body.', 'map', 'all'
             FROM tasks WHERE id = ${fx.taskId}`;
  });
  return fx;
}

describe("drawer/bundle parity (spec §3 item 1)", () => {
  test("working", async () => {
    const fx = await seedFullParityTask("parity-working");
    const parts = formatWorkingContextParts(
      buildWorkingContextFrom(await resolveWorkingData(fx.userId, fx.taskId)),
    );
    expect(drawerOrder(parts, "working")).toEqual([
      ...SECTIONS_BY_BUNDLE.working,
    ]);
  });

  test("planning", async () => {
    const fx = await seedFullParityTask("parity-planning");
    const parts = buildPlanningContextParts(
      await resolvePlanningData(fx.userId, fx.taskId),
    );
    expect(drawerOrder(parts, "planning")).toEqual([
      ...SECTIONS_BY_BUNDLE.planning,
    ]);
  });

  test("agent (in_progress, blocked)", async () => {
    const fx = await seedFullParityTask("parity-agent");
    await srRun(
      (sr) =>
        sr`UPDATE tasks SET status = 'in_progress' WHERE id = ${fx.taskId}`,
    );
    const parts = buildAgentContextParts(
      await resolveDependencyClosure(fx.userId, fx.taskId, "agent"),
    );
    expect(drawerOrder(parts, "agent")).toEqual([...SECTIONS_BY_BUNDLE.agent]);
  });

  test("agent (planned-blocked)", async () => {
    const fx = await seedFullParityTask("parity-agent-planned");
    await srRun(
      (sr) => sr`UPDATE tasks SET status = 'planned' WHERE id = ${fx.taskId}`,
    );
    const parts = buildAgentContextParts(
      await resolveDependencyClosure(fx.userId, fx.taskId, "agent"),
    );
    expect(drawerOrder(parts, "agent")).toEqual([...SECTIONS_BY_BUNDLE.agent]);
  });

  test("review", async () => {
    const fx = await seedFullParityTask("parity-review");
    const parts = buildReviewContextParts(
      await resolveReviewData(fx.userId, fx.taskId),
    );
    expect(drawerOrder(parts, "review")).toEqual([
      ...SECTIONS_BY_BUNDLE.review,
    ]);
  });

  test("record-done", async () => {
    const fx = await seedFullParityTask("parity-rec-done");
    await srRun(
      (sr) => sr`UPDATE tasks SET status = 'done' WHERE id = ${fx.taskId}`,
    );
    const parts = buildRecordContextParts(
      await resolveRecordData(fx.userId, fx.taskId),
    );
    expect(drawerOrder(parts, "record-done")).toEqual([
      ...SECTIONS_BY_BUNDLE["record-done"],
    ]);
  });

  test("record-cancelled", async () => {
    const fx = await seedFullParityTask("parity-rec-cancelled");
    await srRun(
      (sr) => sr`UPDATE tasks SET status = 'cancelled' WHERE id = ${fx.taskId}`,
    );
    const parts = buildRecordContextParts(
      await resolveRecordData(fx.userId, fx.taskId),
    );
    expect(drawerOrder(parts, "record-cancelled")).toEqual([
      ...SECTIONS_BY_BUNDLE["record-cancelled"],
    ]);
  });
});
