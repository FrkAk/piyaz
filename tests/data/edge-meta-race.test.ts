import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask } from "@/lib/data/task";
import { createEdge, updateEdge } from "@/lib/data/edge";

/**
 * Regression test for the stale-compare revert race on `updateEdge`: the
 * `typeChanged` gate compares the incoming type against the baseline read,
 * so an unlocked baseline lets a concurrent writer revert a just-committed
 * type flip while computing `typeChanged: false` — a slim-visible change
 * that never moves `task_edges.meta_updated_at`, freezing the graph
 * validator on a stale 304. The baseline read must take `FOR UPDATE`
 * (mirroring `updateTask`) so it serializes behind the concurrent flip and
 * compares against the committed value.
 */

afterEach(async () => {
  await truncateAll();
});

test("a concurrent type flip cannot be reverted without moving the edge meta clock", async () => {
  const fx = await seedUserOrgProject("edge-meta-race");
  const ctx = makeAuthContext(fx.userId);
  const a = await createTask(ctx, { projectId: fx.projectId, title: "A" });
  const b = await createTask(ctx, { projectId: fx.projectId, title: "B" });
  const edge = await createEdge(ctx, {
    sourceTaskId: a.id,
    targetTaskId: b.id,
    edgeType: "relates_to",
  });

  const su = superuserPool();
  let revert: Promise<unknown> = Promise.resolve();
  let flipEpoch = 0;
  try {
    await su.begin(async (t1) => {
      const [flipped] = await t1<{ m: number }[]>`
        UPDATE task_edges
        SET edge_type = 'depends_on',
            updated_at = now(),
            meta_updated_at = now()
        WHERE id = ${edge.id}
        RETURNING extract(epoch FROM meta_updated_at)::float8 AS m
      `;
      flipEpoch = flipped.m;
      await new Promise((r) => setTimeout(r, 30));
      revert = updateEdge(ctx, edge.id, { edgeType: "relates_to" });
      await new Promise((r) => setTimeout(r, 250));
    });
    await revert;

    const [after] = await su<{ edgeType: string; m: number }[]>`
      SELECT edge_type AS "edgeType",
             extract(epoch FROM meta_updated_at)::float8 AS m
      FROM task_edges WHERE id = ${edge.id}
    `;
    expect(after.edgeType).toBe("relates_to");
    expect(after.m).toBeGreaterThan(flipEpoch);
  } finally {
    await su.end({ timeout: 5 });
  }
});
