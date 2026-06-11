import { afterEach, expect, spyOn, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import * as rls from "@/lib/db/rls";
import {
  getTaskFull,
  getTaskFullWithEdges,
  searchTasks,
} from "@/lib/data/task";

afterEach(async () => {
  await truncateAll();
});

/** Seed two linked tasks in a fresh project; return ids. */
async function seedLinkedTasks(
  suffix: string,
): Promise<{ projectId: string; userId: string; mainId: string }> {
  const fx = await seedUserOrgProject(suffix);
  const sr = serviceRoleConnect();
  try {
    const [main] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, description)
      VALUES (${fx.projectId}, 'Seam main', 1, 'main body')
      RETURNING id`;
    const [other] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number)
      VALUES (${fx.projectId}, 'Seam other', 2)
      RETURNING id`;
    await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type, note)
             VALUES (${main.id}, ${other.id}, 'depends_on', 'seam note')`;
    return { projectId: fx.projectId, userId: fx.userId, mainId: main.id };
  } finally {
    await sr.end({ timeout: 5 });
  }
}

test("getTaskFull resolves in one read batch with no interactive frame", async () => {
  const fx = await seedLinkedTasks("seam-full");
  const readSpy = spyOn(rls, "withUserContextRead");
  const interactiveSpy = spyOn(rls, "withUserContext");

  try {
    const task = await getTaskFull(makeAuthContext(fx.userId), fx.mainId);
    expect(task.title).toBe("Seam main");
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(interactiveSpy).toHaveBeenCalledTimes(0);
  } finally {
    readSpy.mockRestore();
    interactiveSpy.mockRestore();
  }
});

test("getTaskFullWithEdges resolves in one read batch", async () => {
  const fx = await seedLinkedTasks("seam-edges");
  const readSpy = spyOn(rls, "withUserContextRead");

  try {
    const task = await getTaskFullWithEdges(
      makeAuthContext(fx.userId),
      fx.mainId,
    );
    expect(task.title).toBe("Seam main");
    expect(task.edges).toHaveLength(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
  } finally {
    readSpy.mockRestore();
  }
});

test("searchTasks resolves in two read batches with no interactive frame", async () => {
  const fx = await seedLinkedTasks("seam-search");
  const readSpy = spyOn(rls, "withUserContextRead");
  const interactiveSpy = spyOn(rls, "withUserContext");

  try {
    const results = await searchTasks(
      makeAuthContext(fx.userId),
      fx.projectId,
      {
        query: "Seam",
      },
    );
    expect(results.map((r) => r.title).sort()).toEqual([
      "Seam main",
      "Seam other",
    ]);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(interactiveSpy).toHaveBeenCalledTimes(0);
  } finally {
    readSpy.mockRestore();
    interactiveSpy.mockRestore();
  }
});

test("searchTasks derives blocked state through the read path", async () => {
  const fx = await seedLinkedTasks("seam-state");

  const results = await searchTasks(makeAuthContext(fx.userId), fx.projectId, {
    query: "Seam main",
  });

  const main = results.find((r) => r.title === "Seam main");
  expect(main).toBeDefined();
  expect(main?.state).toBe("blocked");
});

test("searchTasks wrong-tenant project throws ForbiddenError", async () => {
  const fx = await seedLinkedTasks("seam-owner");
  const stranger = await seedUserOrgProject("seam-stranger");

  await expect(
    searchTasks(makeAuthContext(stranger.userId), fx.projectId, {
      query: "Seam",
    }),
  ).rejects.toThrow("Forbidden");
});
