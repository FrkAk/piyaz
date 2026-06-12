import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { withUserContext } from "@/lib/db/rls";
import { loadBundleDeps } from "@/lib/graph/effective-deps";

afterEach(async () => {
  await truncateAll();
});

test("loadBundleDeps surfaces per-dep effective depth in both directions", async () => {
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

  const { deps, downstream } = await withUserContext(fx.userId, (tx) =>
    loadBundleDeps(fx.projectId, aId, 2, tx),
  );
  expect(deps).toEqual([
    { id: bId, depth: 1 },
    { id: cId, depth: 2 },
  ]);
  expect(downstream).toEqual([]);

  const fromC = await withUserContext(fx.userId, (tx) =>
    loadBundleDeps(fx.projectId, cId, 2, tx),
  );
  expect(fromC.downstream).toEqual([
    { id: bId, depth: 1 },
    { id: aId, depth: 2 },
  ]);
});
