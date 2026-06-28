import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createEdge } from "@/lib/data/edge";

afterEach(async () => {
  await truncateAll();
});

describe("edge activity", () => {
  test("createEdge records one edge_added row per endpoint", async () => {
    const fx = await seedUserOrgProject("edge-1");
    const sr = serviceRoleConnect();
    let aId: string;
    let bId: string;
    try {
      const [a] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'A', 1) RETURNING id`;
      const [b] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'B', 2) RETURNING id`;
      aId = a.id;
      bId = b.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    await createEdge(ctx, {
      sourceTaskId: aId,
      targetTaskId: bId,
      edgeType: "depends_on",
    });

    const sr2 = serviceRoleConnect();
    try {
      const rows = await sr2<
        {
          task_id: string;
          metadata: { direction: string; relation: string } | null;
        }[]
      >`
        SELECT task_id, metadata FROM activity_events
        WHERE type = 'edge_added'`;
      expect(rows.length).toBe(2);
      const byTask = new Map(rows.map((r) => [r.task_id, r.metadata]));
      // The source endpoint is the dependent (outgoing); the target endpoint
      // is the prerequisite (incoming). edgePhrase reads exactly this metadata
      // (not the summary), so pin the writer's output here.
      expect(byTask.get(aId)).toEqual({
        direction: "outgoing",
        relation: "depends_on",
      });
      expect(byTask.get(bId)).toEqual({
        direction: "incoming",
        relation: "depends_on",
      });
    } finally {
      await sr2.end({ timeout: 5 });
    }
  });
});
