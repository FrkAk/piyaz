import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { seedRichContextTask, normalizeContextGolden } from "./fixtures";
import {
  buildWorkingContext,
  buildWorkingContextFrom,
  formatWorkingContext,
  formatWorkingContextParts,
} from "@/lib/context/_core/working";
import { resolveWorkingData } from "@/lib/context/_core/bundle";
import { makeAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";

afterEach(async () => {
  await truncateAll();
});

describe("buildWorkingContext under app_user", () => {
  test("returns ancestor project for an authorized caller", async () => {
    const fx = await seedUserOrgProject("working-ctx-1");
    const sr = serviceRoleConnect();
    let mainTaskId: string;
    try {
      const [main] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'Main', 1)
        RETURNING id`;
      mainTaskId = main.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const result = await buildWorkingContext(ctx, mainTaskId);
    expect(result.ancestors.length).toBe(1);
    expect(result.ancestors[0].id).toBe(fx.projectId);
    expect(result.edges.length).toBe(0);
  });

  test("returns 1-hop relates_to neighbor in the edges section for an authorized caller", async () => {
    const fx = await seedUserOrgProject("working-ctx-edges");
    const sr = serviceRoleConnect();
    let mainTaskId: string;
    try {
      const [main] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'Main', 1)
        RETURNING id`;
      const [neighbor] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'Neighbor', 2)
        RETURNING id`;
      await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type, note)
               VALUES (${main.id}, ${neighbor.id}, 'relates_to', 'shares the same auth surface')`;
      mainTaskId = main.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const result = await buildWorkingContext(ctx, mainTaskId);
    // Regression gate: working depth dropped its `## Siblings` section in favor
    // of `## Connected Tasks`. That swap is only safe because relates_to 1-hop
    // neighbors land in `edges` — if a future change ever filtered edges to
    // depends_on only, working context would lose the neighbor lane entirely.
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].title).toBe("Neighbor");
    expect(result.edges[0].edgeType).toBe("relates_to");
    expect(result.edges[0].direction).toBe("outgoing");
    expect(result.edges[0].note).toBe("shares the same auth surface");
  });

  test("golden: fully-populated task renders byte-identical working context", async () => {
    const fx = await seedRichContextTask("working-ctx-golden");
    const ctx = makeAuthContext(fx.userId);
    const raw = await buildWorkingContext(ctx, fx.taskId);
    const result = await formatWorkingContext(raw);
    expect(
      normalizeContextGolden(result, "working-ctx-golden"),
    ).toMatchSnapshot();
  });

  test("rejects cross-team callers (RLS isolation under app_user)", async () => {
    const fxA = await seedUserOrgProject("working-ctx-a");
    const fxB = await seedUserOrgProject("working-ctx-b");
    const sr = serviceRoleConnect();
    let taskInAId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fxA.projectId}, 'In team A', 1)
        RETURNING id`;
      taskInAId = t.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fxB.userId);
    await expect(buildWorkingContext(ctx, taskInAId)).rejects.toThrow(
      ForbiddenError,
    );
  });

  test("parts: meta, tags, and hierarchy are adjacent under one meta id", async () => {
    const fx = await seedRichContextTask("working-ctx-parts");
    const parts = formatWorkingContextParts(
      buildWorkingContextFrom(await resolveWorkingData(fx.userId, fx.taskId)),
    );
    expect(parts.map((p) => p.id)).toEqual([
      "notice",
      "header",
      "spec",
      "meta",
      "meta",
      "meta",
      "criteria",
      "decisions",
      "connected",
      "links",
    ]);
    expect(parts.filter((p) => p.id === "meta").map((p) => p.heading)).toEqual([
      "Meta",
      "Tags",
      "Hierarchy",
    ]);
  });
});

test("decisions render with their item id for by-id edit addressing", async () => {
  const fx = await seedUserOrgProject("working-dec-ids");
  const sr = serviceRoleConnect();
  let taskId: string;
  let decisionId: string;
  try {
    const [t] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number)
      VALUES (${fx.projectId}, 'Main', 1)
      RETURNING id`;
    taskId = t.id;
    const [d] = await sr<{ id: string }[]>`
      INSERT INTO task_decisions (id, task_id, text, source, decision_date, position)
      VALUES (gen_random_uuid(), ${taskId}, 'Use Drizzle for the data ring', 'agent', '2026-01-01', 0)
      RETURNING id`;
    decisionId = d.id;
  } finally {
    await sr.end({ timeout: 5 });
  }

  const ctx = makeAuthContext(fx.userId);
  const rendered = await formatWorkingContext(
    await buildWorkingContext(ctx, taskId),
  );
  expect(rendered).toContain(`\`${decisionId}\``);
  expect(rendered).toContain("Use Drizzle for the data ring");
});
