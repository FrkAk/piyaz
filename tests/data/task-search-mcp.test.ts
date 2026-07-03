import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { searchTasksForMcp } from "@/lib/data/task";
import {
  SearchCriteriaRequiredError,
  UnknownCategoryError,
} from "@/lib/graph/errors";
import { ForbiddenError } from "@/lib/auth/authorization";

afterEach(async () => {
  await truncateAll();
});

type TaskSeed = {
  projectId: string;
  title: string;
  sequenceNumber: number;
  status?: string;
  priority?: string | null;
  category?: string | null;
  tags?: string[];
  updatedAtOffsetSec?: number;
};

/**
 * Insert a task through the service-role pool with full control over the
 * filter columns and `updated_at` (for keyset ordering).
 *
 * @param sr - Service-role connection.
 * @param seed - Task field overrides.
 * @returns The created task id.
 */
async function insertTask(
  sr: ReturnType<typeof serviceRoleConnect>,
  seed: TaskSeed,
): Promise<string> {
  const updatedAt = new Date(
    Date.now() + (seed.updatedAtOffsetSec ?? 0) * 1000,
  );
  const [row] = await sr<{ id: string }[]>`
    INSERT INTO tasks (
      project_id, title, sequence_number, status, priority, category, tags,
      updated_at
    ) VALUES (
      ${seed.projectId},
      ${seed.title},
      ${seed.sequenceNumber},
      ${seed.status ?? "planned"},
      ${seed.priority === undefined ? "normal" : seed.priority},
      ${seed.category ?? null},
      ${sr.json(seed.tags ?? [])},
      ${updatedAt}
    )
    RETURNING id
  `;
  return row.id;
}

/**
 * Assign a user to a task through the service-role pool.
 *
 * @param sr - Service-role connection.
 * @param taskId - Task to assign.
 * @param userId - User to add as assignee.
 */
async function assign(
  sr: ReturnType<typeof serviceRoleConnect>,
  taskId: string,
  userId: string,
): Promise<void> {
  await sr`
    INSERT INTO task_assignees (task_id, user_id)
    VALUES (${taskId}, ${userId})
  `;
}

describe("searchTasksForMcp: filters", () => {
  test("rejects a call with no criterion", async () => {
    const fx = await seedUserOrgProject("mcp-none");
    const ctx = makeAuthContext(fx.userId);
    await expect(searchTasksForMcp(ctx, {})).rejects.toBeInstanceOf(
      SearchCriteriaRequiredError,
    );
  });

  test("filters each dimension individually and combined", async () => {
    const fx = await seedUserOrgProject("mcp-filters");
    const sr = serviceRoleConnect();
    let aId: string;
    try {
      aId = await insertTask(sr, {
        projectId: fx.projectId,
        title: "Alpha login bug",
        sequenceNumber: 1,
        status: "in_progress",
        priority: "urgent",
        category: "bug",
        tags: ["auth", "frontend"],
      });
      await insertTask(sr, {
        projectId: fx.projectId,
        title: "Beta dashboard",
        sequenceNumber: 2,
        status: "planned",
        priority: "backlog",
        category: "feature",
        tags: ["frontend"],
      });
      await assign(sr, aId, fx.userId);
    } finally {
      await sr.end({ timeout: 5 });
    }
    const ctx = makeAuthContext(fx.userId);

    const byQuery = await searchTasksForMcp(ctx, { query: "login" });
    expect(byQuery.items.map((i) => i.id)).toEqual([aId]);

    const byStatus = await searchTasksForMcp(ctx, { status: ["in_progress"] });
    expect(byStatus.items.map((i) => i.id)).toEqual([aId]);

    const byPriority = await searchTasksForMcp(ctx, { priority: ["urgent"] });
    expect(byPriority.items.map((i) => i.id)).toEqual([aId]);

    const byCategory = await searchTasksForMcp(ctx, { category: "bug" });
    expect(byCategory.items.map((i) => i.id)).toEqual([aId]);

    const bothTags = await searchTasksForMcp(ctx, {
      tags: ["auth", "frontend"],
    });
    expect(bothTags.items.map((i) => i.id)).toEqual([aId]);

    const oneTag = await searchTasksForMcp(ctx, { tags: ["frontend"] });
    expect(oneTag.items.length).toBe(2);

    const byAssignee = await searchTasksForMcp(ctx, { assignee: fx.userId });
    expect(byAssignee.items.map((i) => i.id)).toEqual([aId]);

    const byMe = await searchTasksForMcp(ctx, { assignee: "me" });
    expect(byMe.items.map((i) => i.id)).toEqual([aId]);

    const combined = await searchTasksForMcp(ctx, {
      status: ["in_progress"],
      priority: ["urgent"],
      tags: ["auth"],
    });
    expect(combined.items.map((i) => i.id)).toEqual([aId]);

    const empty = await searchTasksForMcp(ctx, {
      status: ["done"],
      priority: ["urgent"],
    });
    expect(empty.items).toEqual([]);
  });
});

describe("searchTasksForMcp: modes", () => {
  test("project-scoped carries state; cross-project omits it", async () => {
    const fx = await seedUserOrgProject("mcp-modes");
    const sr = serviceRoleConnect();
    try {
      await insertTask(sr, {
        projectId: fx.projectId,
        title: "Scoped task",
        sequenceNumber: 1,
        status: "planned",
        tags: ["scoped"],
      });
    } finally {
      await sr.end({ timeout: 5 });
    }
    const ctx = makeAuthContext(fx.userId);

    const scoped = await searchTasksForMcp(ctx, {
      projectId: fx.projectId,
      tags: ["scoped"],
    });
    expect(scoped.items.length).toBe(1);
    expect(scoped.items[0].state).toBe("ready");

    const cross = await searchTasksForMcp(ctx, { tags: ["scoped"] });
    expect(cross.items.length).toBe(1);
    expect(cross.items[0].state).toBeUndefined();
    expect(cross.items[0].taskRef).toBe(scoped.items[0].taskRef);
  });

  test("keyset paginates across three pages, newest-first", async () => {
    const fx = await seedUserOrgProject("mcp-page");
    const sr = serviceRoleConnect();
    const ids: string[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        ids.push(
          await insertTask(sr, {
            projectId: fx.projectId,
            title: `Paged ${i}`,
            sequenceNumber: i + 1,
            tags: ["paged"],
            updatedAtOffsetSec: i,
          }),
        );
      }
    } finally {
      await sr.end({ timeout: 5 });
    }
    const ctx = makeAuthContext(fx.userId);
    const newestFirst = [...ids].reverse();

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const res: Awaited<ReturnType<typeof searchTasksForMcp>> =
        await searchTasksForMcp(ctx, {
          tags: ["paged"],
          limit: 2,
          cursor,
        });
      seen.push(...res.items.map((i) => i.id));
      cursor = res.nextCursor;
      if (page < 2) expect(res.nextCursor).not.toBeNull();
    }
    expect(seen).toEqual(newestFirst);
    expect(cursor).toBeNull();
  });
});

describe("searchTasksForMcp: isolation", () => {
  test("cross-project search never returns another org's tasks", async () => {
    const a = await seedUserOrgProject("mcp-iso-a");
    const b = await seedUserOrgProject("mcp-iso-b");
    const sr = serviceRoleConnect();
    let aTaskId: string;
    try {
      aTaskId = await insertTask(sr, {
        projectId: a.projectId,
        title: "Shared word",
        sequenceNumber: 1,
        tags: ["shared"],
      });
      await insertTask(sr, {
        projectId: b.projectId,
        title: "Shared word",
        sequenceNumber: 1,
        tags: ["shared"],
      });
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctxA = makeAuthContext(a.userId);
    const res = await searchTasksForMcp(ctxA, { tags: ["shared"] });
    expect(res.items.map((i) => i.id)).toEqual([aTaskId]);
  });

  test("project-scoped search on a foreign project is forbidden", async () => {
    const a = await seedUserOrgProject("mcp-iso-fa");
    const b = await seedUserOrgProject("mcp-iso-fb");
    const ctxA = makeAuthContext(a.userId);
    await expect(
      searchTasksForMcp(ctxA, { projectId: b.projectId, tags: ["x"] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("searchTasksForMcp: category vocabulary", () => {
  test("project-scoped search rejects a category outside the vocabulary", async () => {
    const f = await seedUserOrgProject("mcp-cat-bad");
    const sr = serviceRoleConnect();
    try {
      await sr`
        UPDATE projects SET categories = ${JSON.stringify(["MCP", "Web"])}::jsonb
        WHERE id = ${f.projectId}`;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const err = await searchTasksForMcp(makeAuthContext(f.userId), {
      projectId: f.projectId,
      category: "NotACategory",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownCategoryError);
    expect((err as UnknownCategoryError).vocabulary).toEqual(["MCP", "Web"]);
  });

  test("project-scoped search accepts a known category and returns matches", async () => {
    const f = await seedUserOrgProject("mcp-cat-ok");
    const sr = serviceRoleConnect();
    let taskId = "";
    try {
      await sr`
        UPDATE projects SET categories = ${JSON.stringify(["MCP", "Web"])}::jsonb
        WHERE id = ${f.projectId}`;
      taskId = await insertTask(sr, {
        projectId: f.projectId,
        title: "Categorized",
        sequenceNumber: 1,
        category: "MCP",
      });
    } finally {
      await sr.end({ timeout: 5 });
    }

    const res = await searchTasksForMcp(makeAuthContext(f.userId), {
      projectId: f.projectId,
      category: "MCP",
    });
    expect(res.items.map((i) => i.id)).toEqual([taskId]);
  });

  test("cross-project search leaves category unvalidated (no scope)", async () => {
    const f = await seedUserOrgProject("mcp-cat-cross");
    const res = await searchTasksForMcp(makeAuthContext(f.userId), {
      category: "NotACategory",
    });
    expect(res.items).toEqual([]);
  });
});
