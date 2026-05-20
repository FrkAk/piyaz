import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createEdge } from "@/lib/data/edge";
import { getCriticalPath } from "@/lib/data/traversal";

/**
 * Coverage for the MYMR-208 fix: `getCriticalPath` filters done tasks
 * locally and weights each DP node by priority instead of `+1`.
 *
 * Tests seed tasks via the service-role connection so they can set
 * `status` and `priority` directly (including the null and unrecognized
 * cases AC 4 requires), then stitch `depends_on` edges via `createEdge`
 * so the production edge-creation path participates in the fixture.
 */

afterEach(async () => {
  await truncateAll();
});

type SeedInput = {
  projectId: string;
  title: string;
  sequenceNumber: number;
  status?: string;
  priority?: string | null;
};

async function insertTask(
  sr: ReturnType<typeof serviceRoleConnect>,
  input: SeedInput,
): Promise<string> {
  const status = input.status ?? "planned";
  // Postgres-js parameter binding handles `null` natively; we use the
  // service-role pool so a non-union priority value bypasses any
  // application-layer validation (the column is plain nullable text).
  const [row] = await sr<{ id: string }[]>`
    INSERT INTO tasks (project_id, title, sequence_number, status, priority)
    VALUES (
      ${input.projectId},
      ${input.title},
      ${input.sequenceNumber},
      ${status},
      ${input.priority === undefined ? "normal" : input.priority}
    )
    RETURNING id
  `;
  return row.id;
}

describe("getCriticalPath: done-transparency and priority weighting", () => {
  test("AC 1: done head of a chain is transparent — A(done) → B → C reports B → C", async () => {
    const fx = await seedUserOrgProject("trav-done-head");
    const sr = serviceRoleConnect();
    const aId = await insertTask(sr, {
      projectId: fx.projectId,
      title: "A",
      sequenceNumber: 1,
      status: "done",
      priority: "normal",
    });
    const bId = await insertTask(sr, {
      projectId: fx.projectId,
      title: "B",
      sequenceNumber: 2,
      status: "planned",
      priority: "normal",
    });
    const cId = await insertTask(sr, {
      projectId: fx.projectId,
      title: "C",
      sequenceNumber: 3,
      status: "draft",
      priority: "normal",
    });

    const ctx = makeAuthContext(fx.userId);
    await createEdge(ctx, {
      sourceTaskId: bId,
      targetTaskId: aId,
      edgeType: "depends_on",
      note: "",
    });
    await createEdge(ctx, {
      sourceTaskId: cId,
      targetTaskId: bId,
      edgeType: "depends_on",
      note: "",
    });

    const chain = await getCriticalPath(ctx, fx.projectId);
    expect(chain.map((t) => t.id)).toEqual([bId, cId]);
    expect(chain.some((t) => t.id === aId)).toBe(false);
    expect(chain[0].status).toBe("planned");
    expect(chain[1].status).toBe("draft");
  });

  test("AC 2: 2-chain of urgent (16) outranks 3-chain of backlog (3)", async () => {
    const fx = await seedUserOrgProject("trav-priority-2v3");
    const sr = serviceRoleConnect();
    const u1 = await insertTask(sr, {
      projectId: fx.projectId,
      title: "U1",
      sequenceNumber: 1,
      priority: "urgent",
    });
    const u2 = await insertTask(sr, {
      projectId: fx.projectId,
      title: "U2",
      sequenceNumber: 2,
      priority: "urgent",
    });
    const b1 = await insertTask(sr, {
      projectId: fx.projectId,
      title: "B1",
      sequenceNumber: 3,
      priority: "backlog",
    });
    const b2 = await insertTask(sr, {
      projectId: fx.projectId,
      title: "B2",
      sequenceNumber: 4,
      priority: "backlog",
    });
    const b3 = await insertTask(sr, {
      projectId: fx.projectId,
      title: "B3",
      sequenceNumber: 5,
      priority: "backlog",
    });

    const ctx = makeAuthContext(fx.userId);
    await createEdge(ctx, {
      sourceTaskId: u2,
      targetTaskId: u1,
      edgeType: "depends_on",
      note: "",
    });
    await createEdge(ctx, {
      sourceTaskId: b2,
      targetTaskId: b1,
      edgeType: "depends_on",
      note: "",
    });
    await createEdge(ctx, {
      sourceTaskId: b3,
      targetTaskId: b2,
      edgeType: "depends_on",
      note: "",
    });

    const chain = await getCriticalPath(ctx, fx.projectId);
    expect(chain.map((t) => t.id)).toEqual([u1, u2]);
  });

  test("Single urgent (8) outranks 3-chain of normal (6)", async () => {
    const fx = await seedUserOrgProject("trav-urgent-vs-normals");
    const sr = serviceRoleConnect();
    const u = await insertTask(sr, {
      projectId: fx.projectId,
      title: "U",
      sequenceNumber: 1,
      priority: "urgent",
    });
    const n1 = await insertTask(sr, {
      projectId: fx.projectId,
      title: "N1",
      sequenceNumber: 2,
      priority: "normal",
    });
    const n2 = await insertTask(sr, {
      projectId: fx.projectId,
      title: "N2",
      sequenceNumber: 3,
      priority: "normal",
    });
    const n3 = await insertTask(sr, {
      projectId: fx.projectId,
      title: "N3",
      sequenceNumber: 4,
      priority: "normal",
    });

    const ctx = makeAuthContext(fx.userId);
    await createEdge(ctx, {
      sourceTaskId: n2,
      targetTaskId: n1,
      edgeType: "depends_on",
      note: "",
    });
    await createEdge(ctx, {
      sourceTaskId: n3,
      targetTaskId: n2,
      edgeType: "depends_on",
      note: "",
    });

    const chain = await getCriticalPath(ctx, fx.projectId);
    expect(chain.map((t) => t.id)).toEqual([u]);
  });

  test("AC 4: null priority defaults to normal weight (2)", async () => {
    const fx = await seedUserOrgProject("trav-null-priority");
    const sr = serviceRoleConnect();
    // 2-chain `Nl(null) → Nm(normal)`: 2 + 2 = 4. A single urgent task
    // (weight 8) standalone must outrank the chain — proves the null
    // default is the `normal` weight (2), not e.g. 0 or NaN.
    const nl = await insertTask(sr, {
      projectId: fx.projectId,
      title: "Nl",
      sequenceNumber: 1,
      priority: null,
    });
    const nm = await insertTask(sr, {
      projectId: fx.projectId,
      title: "Nm",
      sequenceNumber: 2,
      priority: "normal",
    });
    const u = await insertTask(sr, {
      projectId: fx.projectId,
      title: "U",
      sequenceNumber: 3,
      priority: "urgent",
    });

    const ctx = makeAuthContext(fx.userId);
    await createEdge(ctx, {
      sourceTaskId: nm,
      targetTaskId: nl,
      edgeType: "depends_on",
      note: "",
    });

    const chain = await getCriticalPath(ctx, fx.projectId);
    expect(chain.map((t) => t.id)).toEqual([u]);
  });

  test("AC 4: unrecognized priority string defaults to normal weight (2)", async () => {
    const fx = await seedUserOrgProject("trav-weird-priority");
    const sr = serviceRoleConnect();
    // `priority` column is plain nullable text (no CHECK constraint),
    // so a non-union value persists. Same expected behavior as null.
    const w = await insertTask(sr, {
      projectId: fx.projectId,
      title: "W",
      sequenceNumber: 1,
      priority: "weird",
    });
    const wm = await insertTask(sr, {
      projectId: fx.projectId,
      title: "Wm",
      sequenceNumber: 2,
      priority: "normal",
    });
    const u = await insertTask(sr, {
      projectId: fx.projectId,
      title: "U",
      sequenceNumber: 3,
      priority: "urgent",
    });

    const ctx = makeAuthContext(fx.userId);
    await createEdge(ctx, {
      sourceTaskId: wm,
      targetTaskId: w,
      edgeType: "depends_on",
      note: "",
    });

    const chain = await getCriticalPath(ctx, fx.projectId);
    expect(chain.map((t) => t.id)).toEqual([u]);
  });

  test("regression: cancelled-transparency still works inside the priority-weighted DP", async () => {
    const fx = await seedUserOrgProject("trav-cancelled-mid");
    const sr = serviceRoleConnect();
    const a = await insertTask(sr, {
      projectId: fx.projectId,
      title: "A",
      sequenceNumber: 1,
      priority: "normal",
    });
    const m = await insertTask(sr, {
      projectId: fx.projectId,
      title: "M",
      sequenceNumber: 2,
      status: "cancelled",
      priority: "normal",
    });
    const c = await insertTask(sr, {
      projectId: fx.projectId,
      title: "C",
      sequenceNumber: 3,
      priority: "normal",
    });

    const ctx = makeAuthContext(fx.userId);
    await createEdge(ctx, {
      sourceTaskId: m,
      targetTaskId: a,
      edgeType: "depends_on",
      note: "",
    });
    await createEdge(ctx, {
      sourceTaskId: c,
      targetTaskId: m,
      edgeType: "depends_on",
      note: "",
    });

    const chain = await getCriticalPath(ctx, fx.projectId);
    expect(chain.map((t) => t.id)).toEqual([a, c]);
    expect(chain.some((t) => t.id === m)).toBe(false);
    expect(chain[0].status).toBe("planned");
    expect(chain[1].status).toBe("planned");
  });
});
