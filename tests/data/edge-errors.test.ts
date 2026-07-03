import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createEdge } from "@/lib/data/edge";
import {
  CrossProjectEdgeError,
  DuplicateEdgeError,
  EdgeCycleError,
  SelfEdgeError,
} from "@/lib/graph/errors";

/**
 * Insert a task with a chosen sequence number, bypassing RLS.
 *
 * @param projectId - Owning project id.
 * @param seq - Per-project sequence number.
 * @returns Created task id.
 */
async function insertTask(projectId: string, seq: number): Promise<string> {
  const [t] = await superuserPool()<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number")
    VALUES (${projectId}, ${"Task " + seq}, ${seq})
    RETURNING id
  `;
  return t.id;
}

/**
 * Insert a second project into an existing org, bypassing RLS.
 *
 * @param organizationId - Owning org id.
 * @param identifier - Project identifier.
 * @returns Created project id.
 */
async function insertProject(
  organizationId: string,
  identifier: string,
): Promise<string> {
  const [p] = await superuserPool()<{ id: string }[]>`
    INSERT INTO projects ("organization_id", "title", "identifier")
    VALUES (${organizationId}, ${"Project " + identifier}, ${identifier})
    RETURNING id
  `;
  return p.id;
}

/**
 * Await a promise expected to reject and return the thrown value.
 *
 * @param p - Promise expected to reject.
 * @returns The rejection value.
 * @throws Error when the promise resolves instead of rejecting.
 */
async function catchErr(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected promise to reject");
}

afterEach(async () => {
  await truncateAll();
});

describe("createEdge typed errors", () => {
  test("self-edge throws SelfEdgeError with the existing message", async () => {
    const fx = await seedUserOrgProject("1");
    const a = await insertTask(fx.projectId, 1);
    const ctx = makeAuthContext(fx.userId);

    const err = await catchErr(
      createEdge(ctx, {
        sourceTaskId: a,
        targetTaskId: a,
        edgeType: "relates_to",
        note: "",
      }),
    );

    expect(err).toBeInstanceOf(SelfEdgeError);
    expect((err as Error).message).toBe(
      "Cannot create self-edge: source and target are the same task.",
    );
  });

  test("cross-project throws CrossProjectEdgeError", async () => {
    const fx = await seedUserOrgProject("1");
    const otherProject = await insertProject(fx.organizationId, "PRJ1B");
    const a = await insertTask(fx.projectId, 1);
    const b = await insertTask(otherProject, 1);
    const ctx = makeAuthContext(fx.userId);

    const err = await catchErr(
      createEdge(ctx, {
        sourceTaskId: a,
        targetTaskId: b,
        edgeType: "relates_to",
        note: "",
      }),
    );

    expect(err).toBeInstanceOf(CrossProjectEdgeError);
    expect((err as Error).message).toBe(
      "Cannot create edge between tasks in different projects.",
    );
  });

  test("duplicate edge throws DuplicateEdgeError carrying endpoints and type", async () => {
    const fx = await seedUserOrgProject("1");
    const a = await insertTask(fx.projectId, 1);
    const b = await insertTask(fx.projectId, 2);
    const ctx = makeAuthContext(fx.userId);

    await createEdge(ctx, {
      sourceTaskId: a,
      targetTaskId: b,
      edgeType: "relates_to",
      note: "",
    });
    const err = await catchErr(
      createEdge(ctx, {
        sourceTaskId: a,
        targetTaskId: b,
        edgeType: "relates_to",
        note: "",
      }),
    );

    expect(err).toBeInstanceOf(DuplicateEdgeError);
    const dup = err as DuplicateEdgeError;
    expect(dup.message).toBe(
      "Duplicate edge: an identical edge already exists.",
    );
    expect(dup.sourceTaskId).toBe(a);
    expect(dup.targetTaskId).toBe(b);
    expect(dup.edgeType).toBe("relates_to");
  });

  test("cycle throws EdgeCycleError with the chain task ids", async () => {
    const fx = await seedUserOrgProject("1");
    const a = await insertTask(fx.projectId, 1);
    const b = await insertTask(fx.projectId, 2);
    const c = await insertTask(fx.projectId, 3);
    await superuserPool()`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
             VALUES (${a}, ${b}, 'depends_on')`;
    await superuserPool()`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
             VALUES (${b}, ${c}, 'depends_on')`;
    const ctx = makeAuthContext(fx.userId);

    const err = await catchErr(
      createEdge(ctx, {
        sourceTaskId: c,
        targetTaskId: a,
        edgeType: "depends_on",
        note: "",
      }),
    );

    expect(err).toBeInstanceOf(EdgeCycleError);
    const cycle = err as EdgeCycleError;
    expect(cycle.message).toBe(
      "Circular dependency: adding this edge would create a cycle.",
    );
    expect(cycle.chainTaskIds.length).toBeGreaterThan(0);
    expect(cycle.chainTaskIds).toContain(c);
  });
});

test("cycle error carries the loop as taskRefs, closed at the source", async () => {
  const fx = await seedUserOrgProject("1");
  const a = await insertTask(fx.projectId, 1);
  const b = await insertTask(fx.projectId, 2);
  const c = await insertTask(fx.projectId, 3);
  await superuserPool()`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
           VALUES (${a}, ${b}, 'depends_on')`;
  await superuserPool()`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
           VALUES (${b}, ${c}, 'depends_on')`;
  const ctx = makeAuthContext(fx.userId);

  const err = await catchErr(
    createEdge(ctx, {
      sourceTaskId: c,
      targetTaskId: a,
      edgeType: "depends_on",
      note: "",
    }),
  );

  expect(err).toBeInstanceOf(EdgeCycleError);
  const cycle = err as EdgeCycleError;
  expect(cycle.chainRefs[0]).toBe("PRJ1-3");
  expect(cycle.chainRefs[cycle.chainRefs.length - 1]).toBe("PRJ1-3");
  expect(cycle.chainRefs[1]).toBe("PRJ1-1");
  expect(cycle.chainRefs.every((r) => /^PRJ1-\d+$/.test(r))).toBe(true);
});
