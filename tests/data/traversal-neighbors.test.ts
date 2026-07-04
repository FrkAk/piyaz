import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createEdge } from "@/lib/data/edge";
import { getNeighbors } from "@/lib/data/traversal";
import { ForbiddenError } from "@/lib/auth/authorization";

afterEach(async () => {
  await truncateAll();
});

/**
 * Insert a task through the service-role pool.
 *
 * @param sr - Service-role connection.
 * @param projectId - Owning project.
 * @param title - Task title.
 * @param seq - Sequence number.
 * @returns The created task id.
 */
async function insertTask(
  sr: ReturnType<typeof serviceRoleConnect>,
  projectId: string,
  title: string,
  seq: number,
): Promise<string> {
  const [row] = await sr<{ id: string }[]>`
    INSERT INTO tasks (project_id, title, sequence_number, status)
    VALUES (${projectId}, ${title}, ${seq}, 'planned')
    RETURNING id
  `;
  return row.id;
}

describe("getNeighbors", () => {
  test("hop 1 returns both edge types and directions with notes", async () => {
    const fx = await seedUserOrgProject("nb-hop1");
    const sr = serviceRoleConnect();
    let origin: string, dep: string, rel: string;
    try {
      origin = await insertTask(sr, fx.projectId, "Origin", 1);
      dep = await insertTask(sr, fx.projectId, "Dep", 2);
      rel = await insertTask(sr, fx.projectId, "Rel", 3);
    } finally {
      await sr.end({ timeout: 5 });
    }
    const ctx = makeAuthContext(fx.userId);
    await createEdge(ctx, {
      sourceTaskId: origin,
      targetTaskId: dep,
      edgeType: "depends_on",
      note: "blocks release",
    });
    await createEdge(ctx, {
      sourceTaskId: rel,
      targetTaskId: origin,
      edgeType: "relates_to",
      note: "see also",
    });

    const neighbors = await getNeighbors(ctx, origin, 1);
    expect(neighbors.every((n) => n.hop === 1)).toBe(true);

    const outgoing = neighbors.find((n) => n.id === dep);
    expect(outgoing).toMatchObject({
      direction: "outgoing",
      edgeType: "depends_on",
      note: "blocks release",
    });

    const incoming = neighbors.find((n) => n.id === rel);
    expect(incoming).toMatchObject({
      direction: "incoming",
      edgeType: "relates_to",
      note: "see also",
    });
  });

  test("hop 2 dedupes a diamond so the shared task appears once", async () => {
    const fx = await seedUserOrgProject("nb-diamond");
    const sr = serviceRoleConnect();
    let origin: string, a: string, b: string, c: string;
    try {
      origin = await insertTask(sr, fx.projectId, "Origin", 1);
      a = await insertTask(sr, fx.projectId, "A", 2);
      b = await insertTask(sr, fx.projectId, "B", 3);
      c = await insertTask(sr, fx.projectId, "C", 4);
    } finally {
      await sr.end({ timeout: 5 });
    }
    const ctx = makeAuthContext(fx.userId);
    for (const [s, t] of [
      [origin, a],
      [origin, b],
      [a, c],
      [b, c],
    ]) {
      await createEdge(ctx, {
        sourceTaskId: s,
        targetTaskId: t,
        edgeType: "depends_on",
        note: "",
      });
    }

    const neighbors = await getNeighbors(ctx, origin, 2);
    const hop2 = neighbors.filter((n) => n.hop === 2);
    expect(hop2.map((n) => n.id)).toEqual([c]);
    expect(hop2[0].direction).toBe("outgoing");

    const hop1Ids = neighbors
      .filter((n) => n.hop === 1)
      .map((n) => n.id)
      .sort();
    expect(hop1Ids).toEqual([a, b].sort());
    expect(neighbors.some((n) => n.id === origin)).toBe(false);
  });

  test("origin access gate rejects a foreign task", async () => {
    const a = await seedUserOrgProject("nb-gate-a");
    const b = await seedUserOrgProject("nb-gate-b");
    const sr = serviceRoleConnect();
    let foreign: string;
    try {
      foreign = await insertTask(sr, b.projectId, "Foreign", 1);
    } finally {
      await sr.end({ timeout: 5 });
    }
    const ctxA = makeAuthContext(a.userId);
    await expect(getNeighbors(ctxA, foreign, 2)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
