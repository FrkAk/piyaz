import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { resolveDependencyClosure } from "@/lib/context/_core/bundle";
import { effectiveNeighbors } from "@/lib/ui/effective-prereqs";
import { CLOSURE_DEPTH } from "@/lib/context/parts";
import type { TaskGraphEdge } from "@/lib/data/views";

afterEach(async () => {
  await truncateAll();
});

test("dependency closure surfaces per-dep effective depth in both directions", async () => {
  const fx = await seedUserOrgProject("eff-deps-depth");
  const sr = serviceRoleConnect();
  let aId: string, bId: string, cId: string;
  try {
    const [a] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number) VALUES (${fx.projectId}, 'A', 1) RETURNING id`;
    const [b] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number) VALUES (${fx.projectId}, 'B', 2) RETURNING id`;
    const [c] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number) VALUES (${fx.projectId}, 'C', 3) RETURNING id`;
    await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
             VALUES (${a.id}, ${b.id}, 'depends_on'), (${b.id}, ${c.id}, 'depends_on')`;
    aId = a.id;
    bId = b.id;
    cId = c.id;
  } finally {
    await sr.end({ timeout: 5 });
  }

  const { deps, downstream } = await resolveDependencyClosure(
    fx.userId,
    aId,
    "agent",
  );
  expect(deps).toEqual([
    { id: bId, depth: 1 },
    { id: cId, depth: 2 },
  ]);
  expect(downstream).toEqual([]);

  const fromC = await resolveDependencyClosure(fx.userId, cId, "agent");
  expect(fromC.downstream).toEqual([
    { id: bId, depth: 1 },
    { id: aId, depth: 2 },
  ]);
});

test("client effectiveNeighbors walk agrees with the SQL closure walk", async () => {
  // A → B(cancelled) → C → D, plus relates_to noise. The SQL recursive CTE
  // and the client BFS must agree on ids and effective depths in both
  // directions; this is the only test exercising both walks on one fixture.
  const fx = await seedUserOrgProject("eff-deps-parity");
  const sr = serviceRoleConnect();
  const ids: Record<string, string> = {};
  const edges: TaskGraphEdge[] = [];
  const statusMap = new Map<string, { status: string }>();
  try {
    const specs: [string, string][] = [
      ["A", "planned"],
      ["B", "cancelled"],
      ["C", "planned"],
      ["D", "draft"],
    ];
    let seq = 1;
    for (const [name, status] of specs) {
      const [row] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, status)
        VALUES (${fx.projectId}, ${name}, ${seq++}, ${status}) RETURNING id`;
      ids[name] = row.id;
      statusMap.set(row.id, { status });
    }
    const depEdges: [string, string][] = [
      ["A", "B"],
      ["B", "C"],
      ["C", "D"],
    ];
    for (const [s, t] of depEdges) {
      const [e] = await sr<{ id: string }[]>`
        INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
        VALUES (${ids[s]}, ${ids[t]}, 'depends_on') RETURNING id`;
      edges.push({
        id: e.id,
        sourceTaskId: ids[s],
        targetTaskId: ids[t],
        edgeType: "depends_on",
      });
    }
    const [rel] = await sr<{ id: string }[]>`
      INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
      VALUES (${ids.A}, ${ids.D}, 'relates_to') RETURNING id`;
    edges.push({
      id: rel.id,
      sourceTaskId: ids.A,
      targetTaskId: ids.D,
      edgeType: "relates_to",
    });
  } finally {
    await sr.end({ timeout: 5 });
  }

  const sqlClosure = await resolveDependencyClosure(fx.userId, ids.A, "agent");
  const clientUpstream = effectiveNeighbors(
    ids.A,
    edges,
    statusMap,
    "upstream",
    CLOSURE_DEPTH,
  );
  // B is cancelled (transparent): C surfaces at depth 1, D at depth 2.
  expect(sqlClosure.deps).toEqual([
    { id: ids.C, depth: 1 },
    { id: ids.D, depth: 2 },
  ]);
  expect(clientUpstream).toEqual(sqlClosure.deps);

  const sqlFromD = await resolveDependencyClosure(fx.userId, ids.D, "agent");
  const clientDownstream = effectiveNeighbors(
    ids.D,
    edges,
    statusMap,
    "downstream",
    CLOSURE_DEPTH,
  );
  expect(clientDownstream).toEqual(sqlFromD.downstream);
});
