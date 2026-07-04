import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import {
  MalformedRefError,
  RefAmbiguityError,
  RefNotFoundError,
  resolveProjectRef,
  resolveTaskRef,
  resolveTaskRefs,
} from "@/lib/data/resolve-ref";

/**
 * Insert an organization, an owner-membership for the user, and a project
 * with a caller-chosen identifier. Bypasses RLS (superuser) so a single
 * user can be seeded into several orgs sharing one identifier.
 *
 * @param suffix - Unique suffix for the org slug (avoids collisions).
 * @param identifier - Project identifier (stored verbatim, uppercase).
 * @param userId - User to grant owner membership.
 * @returns Created org and project ids plus the org name.
 */
async function seedOrgWithProject(
  suffix: string,
  identifier: string,
  userId: string,
): Promise<{ organizationId: string; projectId: string; teamName: string }> {
  const su = superuserPool();
  const teamName = "Team " + suffix;
  const [o] = await su<{ id: string }[]>`
    INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
    VALUES (${teamName}, ${"team-" + suffix}, now())
    RETURNING id
  `;
  await su`
    INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
    VALUES (${o.id}, ${userId}, 'owner', now())
  `;
  const [p] = await su<{ id: string }[]>`
    INSERT INTO projects ("organization_id", "title", "identifier")
    VALUES (${o.id}, ${"Project " + suffix}, ${identifier})
    RETURNING id
  `;
  return { organizationId: o.id, projectId: p.id, teamName };
}

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

describe("resolveTaskRef", () => {
  test("resolves a ref to its task with projectId and taskRef", async () => {
    const fx = await seedUserOrgProject("1");
    const taskId = await insertTask(fx.projectId, 5);
    const ctx = makeAuthContext(fx.userId);

    const result = await resolveTaskRef(ctx, "PRJ1-5");

    expect(result.taskId).toBe(taskId);
    expect(result.projectId).toBe(fx.projectId);
    expect(result.taskRef).toBe("PRJ1-5");
  });

  test("passes a UUID through without a query, even when it does not exist", async () => {
    const fx = await seedUserOrgProject("1");
    const ctx = makeAuthContext(fx.userId);
    const ghost = crypto.randomUUID();

    const result = await resolveTaskRef(ctx, ghost);

    expect(result.taskId).toBe(ghost);
    expect(result.projectId).toBeUndefined();
    expect(result.taskRef).toBeUndefined();
  });

  test("resolves case-insensitively", async () => {
    const fx = await seedUserOrgProject("1");
    const taskId = await insertTask(fx.projectId, 7);
    const ctx = makeAuthContext(fx.userId);

    for (const ref of ["prj1-7", "Prj1-7", "PRJ1-7"]) {
      const result = await resolveTaskRef(ctx, ref);
      expect(result.taskId).toBe(taskId);
      expect(result.taskRef).toBe("PRJ1-7");
    }
  });

  test("throws RefAmbiguityError when a ref matches two of the caller's teams", async () => {
    const fx = await seedUserOrgProject("1");
    const b = await seedOrgWithProject("dup-b", "DUP", fx.userId);
    const a = await seedOrgWithProject("dup-a", "DUP", fx.userId);
    const taskA = await insertTask(a.projectId, 1);
    const taskB = await insertTask(b.projectId, 1);
    const ctx = makeAuthContext(fx.userId);

    const err = await catchErr(resolveTaskRef(ctx, "DUP-1"));

    expect(err).toBeInstanceOf(RefAmbiguityError);
    const ambiguity = err as RefAmbiguityError;
    expect(ambiguity.ref).toBe("DUP-1");
    expect(ambiguity.candidates).toHaveLength(2);
    expect(new Set(ambiguity.candidates.map((c) => c.taskId))).toEqual(
      new Set([taskA, taskB]),
    );
    expect(new Set(ambiguity.candidates.map((c) => c.projectId))).toEqual(
      new Set([a.projectId, b.projectId]),
    );
    for (const c of ambiguity.candidates) {
      expect(c.teamName).toBeTruthy();
      expect(c.projectTitle).toBeTruthy();
    }
  });

  test("misses with a visible prefix carry projectIdentifier and maxSequenceNumber", async () => {
    const fx = await seedUserOrgProject("1");
    await insertTask(fx.projectId, 1);
    await insertTask(fx.projectId, 2);
    await insertTask(fx.projectId, 3);
    const ctx = makeAuthContext(fx.userId);

    const err = await catchErr(resolveTaskRef(ctx, "PRJ1-99"));

    expect(err).toBeInstanceOf(RefNotFoundError);
    const notFound = err as RefNotFoundError;
    expect(notFound.ref).toBe("PRJ1-99");
    expect(notFound.projectIdentifier).toBe("PRJ1");
    expect(notFound.maxSequenceNumber).toBe(3);
  });

  test("misses with an invisible prefix do not leak the project", async () => {
    const fx = await seedUserOrgProject("1");
    const ctx = makeAuthContext(fx.userId);

    const hidden = await seedOrgWithProject("hidden", "HIDDEN", fx.userId);
    await insertTask(hidden.projectId, 1);
    await superuserPool()`DELETE FROM piyaz_auth."member" WHERE "organizationId" = ${hidden.organizationId} AND "userId" = ${fx.userId}`;

    const err = await catchErr(resolveTaskRef(ctx, "HIDDEN-1"));

    expect(err).toBeInstanceOf(RefNotFoundError);
    const notFound = err as RefNotFoundError;
    expect(notFound.ref).toBe("HIDDEN-1");
    expect(notFound.projectIdentifier).toBeUndefined();
    expect(notFound.maxSequenceNumber).toBeUndefined();
  });

  test("throws MalformedRefError for input that is neither UUID nor ref", async () => {
    const fx = await seedUserOrgProject("1");
    const ctx = makeAuthContext(fx.userId);

    const err = await catchErr(resolveTaskRef(ctx, "not a ref!!"));

    expect(err).toBeInstanceOf(MalformedRefError);
    expect((err as MalformedRefError).input).toBe("not a ref!!");
  });
});

describe("resolveTaskRefs", () => {
  test("resolves a mixed batch of UUIDs and refs in one map", async () => {
    const fx = await seedUserOrgProject("1");
    const task1 = await insertTask(fx.projectId, 1);
    const task2 = await insertTask(fx.projectId, 2);
    const ctx = makeAuthContext(fx.userId);
    const ghost = crypto.randomUUID();

    const map = await resolveTaskRefs(ctx, [ghost, "PRJ1-1", "prj1-2"]);

    expect(map.size).toBe(3);
    expect(map.get(ghost)).toEqual({ taskId: ghost });
    expect(map.get("PRJ1-1")).toEqual({
      taskId: task1,
      projectId: fx.projectId,
      taskRef: "PRJ1-1",
    });
    expect(map.get("prj1-2")).toEqual({
      taskId: task2,
      projectId: fx.projectId,
      taskRef: "PRJ1-2",
    });
  });

  test("throws MalformedRefError when a batch input is neither UUID nor ref", async () => {
    const fx = await seedUserOrgProject("1");
    const ctx = makeAuthContext(fx.userId);

    const err = await catchErr(resolveTaskRefs(ctx, ["PRJ1-1", "garbage!!"]));

    expect(err).toBeInstanceOf(MalformedRefError);
  });
});

describe("resolveProjectRef", () => {
  test("resolves an identifier to its project", async () => {
    const fx = await seedUserOrgProject("1");
    const ctx = makeAuthContext(fx.userId);

    const result = await resolveProjectRef(ctx, "prj1");

    expect(result.projectId).toBe(fx.projectId);
    expect(result.identifier).toBe("PRJ1");
    expect(result.organizationId).toBe(fx.organizationId);
  });

  test("passes a UUID through without a query", async () => {
    const fx = await seedUserOrgProject("1");
    const ctx = makeAuthContext(fx.userId);
    const ghost = crypto.randomUUID();

    const result = await resolveProjectRef(ctx, ghost);

    expect(result.projectId).toBe(ghost);
    expect(result.identifier).toBeUndefined();
    expect(result.organizationId).toBeUndefined();
  });

  test("throws RefAmbiguityError when an identifier matches two of the caller's teams", async () => {
    const fx = await seedUserOrgProject("1");
    const a = await seedOrgWithProject("proj-dup-a", "DUP", fx.userId);
    const b = await seedOrgWithProject("proj-dup-b", "DUP", fx.userId);
    const ctx = makeAuthContext(fx.userId);

    const err = await catchErr(resolveProjectRef(ctx, "DUP"));

    expect(err).toBeInstanceOf(RefAmbiguityError);
    const ambiguity = err as RefAmbiguityError;
    expect(ambiguity.candidates).toHaveLength(2);
    expect(new Set(ambiguity.candidates.map((c) => c.projectId))).toEqual(
      new Set([a.projectId, b.projectId]),
    );
    for (const c of ambiguity.candidates) {
      expect(c.taskId).toBeUndefined();
      expect(c.teamName).toBeTruthy();
    }
  });

  test("throws MalformedRefError for a non-UUID non-identifier input", async () => {
    const fx = await seedUserOrgProject("1");
    const ctx = makeAuthContext(fx.userId);

    const err = await catchErr(resolveProjectRef(ctx, "bad ref!!"));

    expect(err).toBeInstanceOf(MalformedRefError);
  });
});

test("near-miss across two same-identifier teams names each team's max ref", async () => {
  const fx = await seedUserOrgProject("1");
  const a = await seedOrgWithProject("nm-a", "DUP", fx.userId);
  const b = await seedOrgWithProject("nm-b", "DUP", fx.userId);
  await insertTask(a.projectId, 1);
  await insertTask(a.projectId, 2);
  await insertTask(b.projectId, 1);
  const ctx = makeAuthContext(fx.userId);

  const err = await catchErr(resolveTaskRef(ctx, "DUP-99"));

  expect(err).toBeInstanceOf(RefNotFoundError);
  const notFound = err as RefNotFoundError;
  expect(notFound.nearMisses).toHaveLength(2);
  const byTeam = new Map(
    notFound.nearMisses.map((p) => [p.teamName, p.maxSequenceNumber]),
  );
  expect(byTeam.get(a.teamName)).toBe(2);
  expect(byTeam.get(b.teamName)).toBe(1);
});
