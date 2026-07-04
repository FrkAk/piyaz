import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import {
  createTask,
  getTaskFull,
  type UpdateTaskResult,
} from "@/lib/data/task";
import {
  applyTaskEdit,
  CollectionItemNotFoundError,
  DuplicateLinkUrlError,
  InvalidEditOpError,
  StaleWriteError,
  StrReplaceMultipleMatchError,
  StrReplaceNoMatchError,
  type ApplyTaskEditResult,
} from "@/lib/data/task-edit";
import { makeAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { InvalidLinkUrlError, UnknownCategoryError } from "@/lib/graph/errors";

afterEach(async () => {
  await truncateAll();
});

/**
 * Narrow an edit result to the updated-task variant.
 *
 * @param result - Result of an edit-path {@link applyTaskEdit} call.
 * @returns The updated task row with `applied`.
 */
function asEdit(
  result: ApplyTaskEditResult,
): UpdateTaskResult & { applied: string[] } {
  if ("deleted" in result || "task" in result)
    throw new Error("expected an edit result, got a delete result");
  return result;
}

/**
 * Count activity events of a given type on a task, bypassing RLS.
 *
 * @param taskId - Task whose events to inspect.
 * @returns Array of `{ type, metadata }` rows.
 */
async function activityRows(
  taskId: string,
): Promise<{ type: string; metadata: Record<string, unknown> | null }[]> {
  const sr = serviceRoleConnect();
  return sr<{ type: string; metadata: Record<string, unknown> | null }[]>`
    SELECT type, metadata FROM activity_events WHERE task_id = ${taskId}`;
}

test("str_replace replaces a unique match", async () => {
  const f = await seedUserOrgProject("sr-unique");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "alpha beta gamma",
  });

  const res = await applyTaskEdit(ctx, task.id, [
    { op: "str_replace", field: "description", oldStr: "beta", newStr: "BETA" },
  ]);

  expect(res.applied).toEqual(["str_replace description"]);
  const full = await getTaskFull(ctx, task.id);
  expect(full.description).toBe("alpha BETA gamma");
});

test("str_replace with no match raises StrReplaceNoMatchError", async () => {
  const f = await seedUserOrgProject("sr-none");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "alpha beta gamma",
  });

  const err = await applyTaskEdit(ctx, task.id, [
    { op: "str_replace", field: "description", oldStr: "zzz", newStr: "x" },
  ]).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(StrReplaceNoMatchError);
  expect((err as StrReplaceNoMatchError).field).toBe("description");
});

test("str_replace with multiple matches raises StrReplaceMultipleMatchError", async () => {
  const f = await seedUserOrgProject("sr-multi");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "repeat once repeat",
  });

  const err = await applyTaskEdit(ctx, task.id, [
    { op: "str_replace", field: "description", oldStr: "repeat", newStr: "x" },
  ]).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(StrReplaceMultipleMatchError);
  expect((err as StrReplaceMultipleMatchError).count).toBe(2);
});

test("append joins with a blank line and sets a previously null field", async () => {
  const f = await seedUserOrgProject("append");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await applyTaskEdit(ctx, task.id, [
    { op: "append", field: "implementationPlan", text: "step one" },
  ]);
  let full = await getTaskFull(ctx, task.id);
  expect(full.implementationPlan).toBe("step one");

  await applyTaskEdit(ctx, task.id, [
    { op: "append", field: "implementationPlan", text: "step two" },
  ]);
  full = await getTaskFull(ctx, task.id);
  expect(full.implementationPlan).toBe("step one\n\nstep two");
});

test("set replaces wholesale and applies markdown formatting", async () => {
  const f = await seedUserOrgProject("set-text");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "original",
  });

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "description", value: "  hello  \n\n\n" },
  ]);

  const full = await getTaskFull(ctx, task.id);
  expect(full.description).toBe("hello");
});

test("chained text ops see prior ops' results", async () => {
  const f = await seedUserOrgProject("chained");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "aaa",
  });

  await applyTaskEdit(ctx, task.id, [
    { op: "str_replace", field: "description", oldStr: "aaa", newStr: "bbb" },
    { op: "append", field: "description", text: "ccc" },
  ]);

  const full = await getTaskFull(ctx, task.id);
  expect(full.description).toBe("bbb\n\nccc");
});

test("ifUpdatedAt gates stale writes and passes fresh ones", async () => {
  const f = await seedUserOrgProject("stale");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const r1 = asEdit(
    await applyTaskEdit(ctx, task.id, [
      { op: "set", field: "title", value: "one" },
    ]),
  );
  const r2 = asEdit(
    await applyTaskEdit(
      ctx,
      task.id,
      [{ op: "set", field: "title", value: "two" }],
      r1.updatedAt.toISOString(),
    ),
  );
  expect(r2.title).toBe("two");

  const err = await applyTaskEdit(
    ctx,
    task.id,
    [{ op: "set", field: "title", value: "three" }],
    r1.updatedAt.toISOString(),
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(StaleWriteError);
  expect((err as StaleWriteError).currentUpdatedAt.getTime()).toBe(
    r2.updatedAt.getTime(),
  );

  const r3 = asEdit(
    await applyTaskEdit(ctx, task.id, [
      { op: "set", field: "title", value: "four" },
    ]),
  );
  expect(r3.title).toBe("four");
});

test("criteria add lands at the end and dedups by text preserving id", async () => {
  const f = await seedUserOrgProject("crit-add");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    acceptanceCriteria: ["A"],
  });
  const before = await getTaskFull(ctx, task.id);
  const aId = before.acceptanceCriteria[0].id;

  await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "acceptanceCriteria", text: "B" },
  ]);
  let full = await getTaskFull(ctx, task.id);
  expect(full.acceptanceCriteria.map((c) => c.text)).toEqual(["A", "B"]);

  await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "acceptanceCriteria", text: "A", checked: true },
  ]);
  full = await getTaskFull(ctx, task.id);
  expect(full.acceptanceCriteria.map((c) => c.text)).toEqual(["A", "B"]);
  const a = full.acceptanceCriteria.find((c) => c.text === "A");
  expect(a?.id).toBe(aId);
  expect(a?.checked).toBe(true);
});

test("criteria update preserves position and unsupplied checked", async () => {
  const f = await seedUserOrgProject("crit-update");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    acceptanceCriteria: ["A", "B"],
  });
  const before = await getTaskFull(ctx, task.id);
  const aId = before.acceptanceCriteria[0].id;
  const bId = before.acceptanceCriteria[1].id;

  await applyTaskEdit(ctx, task.id, [
    { op: "check", collection: "acceptanceCriteria", id: bId },
  ]);
  await applyTaskEdit(ctx, task.id, [
    { op: "update", collection: "acceptanceCriteria", id: aId, text: "A2" },
  ]);

  const full = await getTaskFull(ctx, task.id);
  expect(full.acceptanceCriteria.map((c) => c.text)).toEqual(["A2", "B"]);
  const a = full.acceptanceCriteria.find((c) => c.id === aId);
  const b = full.acceptanceCriteria.find((c) => c.id === bId);
  expect(a?.checked).toBe(false);
  expect(b?.checked).toBe(true);
});

test("criteria check and uncheck toggle only the checked flag", async () => {
  const f = await seedUserOrgProject("crit-check");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    acceptanceCriteria: ["X"],
  });
  const before = await getTaskFull(ctx, task.id);
  const xId = before.acceptanceCriteria[0].id;

  await applyTaskEdit(ctx, task.id, [
    { op: "check", collection: "acceptanceCriteria", id: xId },
  ]);
  let full = await getTaskFull(ctx, task.id);
  expect(full.acceptanceCriteria[0].checked).toBe(true);
  expect(full.acceptanceCriteria[0].text).toBe("X");

  await applyTaskEdit(ctx, task.id, [
    { op: "uncheck", collection: "acceptanceCriteria", id: xId },
  ]);
  full = await getTaskFull(ctx, task.id);
  expect(full.acceptanceCriteria[0].checked).toBe(false);
});

test("criteria remove deletes exactly one item", async () => {
  const f = await seedUserOrgProject("crit-remove");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    acceptanceCriteria: ["A", "B"],
  });
  const before = await getTaskFull(ctx, task.id);
  const aId = before.acceptanceCriteria[0].id;

  await applyTaskEdit(ctx, task.id, [
    { op: "remove", collection: "acceptanceCriteria", id: aId },
  ]);

  const full = await getTaskFull(ctx, task.id);
  expect(full.acceptanceCriteria.map((c) => c.text)).toEqual(["B"]);
});

test("criteria op with unknown id raises CollectionItemNotFoundError", async () => {
  const f = await seedUserOrgProject("crit-missing");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    acceptanceCriteria: ["A"],
  });
  const before = await getTaskFull(ctx, task.id);

  const err = await applyTaskEdit(ctx, task.id, [
    {
      op: "update",
      collection: "acceptanceCriteria",
      id: "00000000-0000-4000-8000-000000000000",
      text: "z",
    },
  ]).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(CollectionItemNotFoundError);
  const ce = err as CollectionItemNotFoundError;
  expect(ce.collection).toBe("acceptanceCriteria");
  expect(ce.currentItems).toEqual([
    { id: before.acceptanceCriteria[0].id, text: "A" },
  ]);
});

test("decisions add, update, and remove mirror criteria", async () => {
  const f = await seedUserOrgProject("decisions");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "decisions", text: "D1" },
  ]);
  let full = await getTaskFull(ctx, task.id);
  expect(full.decisions.map((d) => d.text)).toEqual(["D1"]);
  const dId = full.decisions[0].id;

  await applyTaskEdit(ctx, task.id, [
    { op: "update", collection: "decisions", id: dId, text: "D1b" },
  ]);
  full = await getTaskFull(ctx, task.id);
  expect(full.decisions[0].text).toBe("D1b");

  await applyTaskEdit(ctx, task.id, [
    { op: "remove", collection: "decisions", id: dId },
  ]);
  full = await getTaskFull(ctx, task.id);
  expect(full.decisions).toEqual([]);
});

test("set on a text field accepts the documented text param", async () => {
  const f = await seedUserOrgProject("set-text-param");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "original",
  });

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "implementationPlan", text: "Plan via text param" },
  ]);
  const full = await getTaskFull(ctx, task.id);
  expect(full.implementationPlan).toContain("Plan via text param");
});

test("assignees add/remove accept the documented value param", async () => {
  const f = await seedUserOrgProject("assignee-value");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "assignees", value: "me" },
  ]);
  let full = await getTaskFull(ctx, task.id);
  expect(full.assignees.map((a) => a.userId)).toEqual([f.userId]);

  await applyTaskEdit(ctx, task.id, [
    { op: "remove", collection: "assignees", value: f.userId },
  ]);
  full = await getTaskFull(ctx, task.id);
  expect(full.assignees).toEqual([]);
});

test("assignees add 'me' resolves to the caller and remove clears it", async () => {
  const f = await seedUserOrgProject("assignee-me");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "assignees", id: "me" },
  ]);
  let full = await getTaskFull(ctx, task.id);
  expect(full.assignees.map((a) => a.userId)).toEqual([f.userId]);

  await applyTaskEdit(ctx, task.id, [
    { op: "remove", collection: "assignees", id: f.userId },
  ]);
  full = await getTaskFull(ctx, task.id);
  expect(full.assignees).toEqual([]);
});

test("assignees add rejects a non-team member", async () => {
  const f = await seedUserOrgProject("assignee-reject");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const su = superuserPool();
  const [stranger] = await su<{ id: string }[]>`
    INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
    VALUES ('Stranger', 'stranger-edit@test.local', true, now())
    RETURNING id
  `;

  const err = await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "assignees", id: stranger.id },
  ]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ForbiddenError);
});

test("links add, update, and remove operate on the task's links", async () => {
  const f = await seedUserOrgProject("links");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await applyTaskEdit(ctx, task.id, [
    {
      op: "add",
      collection: "links",
      url: "https://github.com/o/r/pull/1",
    },
  ]);
  let full = await getTaskFull(ctx, task.id);
  expect(full.links.map((l) => l.url)).toEqual([
    "https://github.com/o/r/pull/1",
  ]);
  const linkId = full.links[0].id;

  await applyTaskEdit(ctx, task.id, [
    {
      op: "update",
      collection: "links",
      id: linkId,
      url: "https://github.com/o/r/pull/2",
    },
  ]);
  full = await getTaskFull(ctx, task.id);
  expect(full.links.map((l) => l.url)).toEqual([
    "https://github.com/o/r/pull/2",
  ]);

  await applyTaskEdit(ctx, task.id, [
    { op: "remove", collection: "links", id: linkId },
  ]);
  full = await getTaskFull(ctx, task.id);
  expect(full.links).toEqual([]);
});

test("prUrl set to null removes the pull_request link", async () => {
  const f = await seedUserOrgProject("prurl");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "prUrl", value: "https://github.com/o/r/pull/5" },
  ]);
  let full = await getTaskFull(ctx, task.id);
  expect(full.links.map((l) => l.kind)).toEqual(["pull_request"]);

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "prUrl", value: null },
  ]);
  full = await getTaskFull(ctx, task.id);
  expect(full.links).toEqual([]);
});

test("set prUrl converts a same-url link of another kind to pull_request", async () => {
  const f = await seedUserOrgProject("prurl-convert");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  const url = "https://example.com/docs/spec";

  await applyTaskEdit(ctx, task.id, [{ op: "add", collection: "links", url }]);
  let full = await getTaskFull(ctx, task.id);
  expect(full.links.map((l) => l.kind)).toEqual(["link"]);

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "prUrl", value: url },
  ]);
  full = await getTaskFull(ctx, task.id);
  expect(full.links).toHaveLength(1);
  expect(full.links[0]?.kind).toBe("pull_request");
});

test("set prUrl forces pull_request kind for non-github hosts", async () => {
  const f = await seedUserOrgProject("prurl-host");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await applyTaskEdit(ctx, task.id, [
    {
      op: "set",
      field: "prUrl",
      value: "https://bitbucket.org/o/r/pull-requests/7",
    },
  ]);
  const full = await getTaskFull(ctx, task.id);
  expect(full.links.map((l) => l.kind)).toEqual(["pull_request"]);
});

test("set prUrl with a second url keeps both pull_request links", async () => {
  const f = await seedUserOrgProject("prurl-multi");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "prUrl", value: "https://github.com/o/r/pull/1" },
  ]);
  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "prUrl", value: "https://github.com/o/r/pull/2" },
  ]);
  const full = await getTaskFull(ctx, task.id);
  expect(full.links.map((l) => l.kind)).toEqual([
    "pull_request",
    "pull_request",
  ]);
  expect(full.links.map((l) => l.url).sort()).toEqual([
    "https://github.com/o/r/pull/1",
    "https://github.com/o/r/pull/2",
  ]);
});

test("scalar set fires status and tag activity events", async () => {
  const f = await seedUserOrgProject("scalar");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    tags: ["a", "b"],
  });

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "status", value: "in_progress" },
    { op: "set", field: "tags", value: ["b", "c"] },
  ]);

  const rows = await activityRows(task.id);
  const status = rows.find((r) => r.type === "status_changed");
  expect(status?.metadata).toEqual({ from: "draft", to: "in_progress" });
  const added = rows.filter((r) => r.type === "tag_added").length;
  const removed = rows.filter((r) => r.type === "tag_removed").length;
  expect(added).toBe(1);
  expect(removed).toBe(1);
});

test("a failing op rolls back earlier ops in the same call", async () => {
  const f = await seedUserOrgProject("atomic");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "orig",
    acceptanceCriteria: ["A"],
  });

  const err = await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "description", value: "new" },
    { op: "add", collection: "acceptanceCriteria", text: "B" },
    {
      op: "remove",
      collection: "acceptanceCriteria",
      id: "00000000-0000-4000-8000-000000000000",
    },
  ]).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(CollectionItemNotFoundError);
  const full = await getTaskFull(ctx, task.id);
  expect(full.description).toBe("orig");
  expect(full.acceptanceCriteria.map((c) => c.text)).toEqual(["A"]);
});

test("delete_task previews by default and deletes when preview is false", async () => {
  const f = await seedUserOrgProject("delete");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const preview = await applyTaskEdit(ctx, task.id, [{ op: "delete_task" }]);
  expect("task" in preview).toBe(true);
  await getTaskFull(ctx, task.id);

  await applyTaskEdit(ctx, task.id, [{ op: "delete_task", preview: false }]);
  const gone = await getTaskFull(ctx, task.id).catch((e: unknown) => e);
  expect(gone).toBeInstanceOf(ForbiddenError);
});

test("delete_task combined with another op is rejected", async () => {
  const f = await seedUserOrgProject("delete-combo");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const err = await applyTaskEdit(ctx, task.id, [
    { op: "delete_task" },
    { op: "set", field: "title", value: "x" },
  ]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(InvalidEditOpError);
});

test("a multi-op call writes one event per collection change", async () => {
  const f = await seedUserOrgProject("multi-activity");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "status", value: "in_progress" },
    { op: "add", collection: "acceptanceCriteria", text: "X" },
    { op: "add", collection: "decisions", text: "D" },
  ]);

  const types = new Set((await activityRows(task.id)).map((r) => r.type));
  expect(types.has("status_changed")).toBe(true);
  expect(types.has("criterion_added")).toBe(true);
  expect(types.has("decision_added")).toBe(true);
});

test("op coherence rejects invalid ops before any DB work", async () => {
  const f = await seedUserOrgProject("coherence");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const checkErr = await applyTaskEdit(ctx, task.id, [
    { op: "check", collection: "decisions", id: "x" },
  ]).catch((e: unknown) => e);
  expect(checkErr).toBeInstanceOf(InvalidEditOpError);

  const setErr = await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "status" },
  ]).catch((e: unknown) => e);
  expect(setErr).toBeInstanceOf(InvalidEditOpError);
});

test("criteria re-add with omitted checked keeps a checked item checked", async () => {
  const f = await seedUserOrgProject("crit-readd-omit");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    acceptanceCriteria: ["A", "B"],
  });
  const before = await getTaskFull(ctx, task.id);
  const aId = before.acceptanceCriteria[0].id;

  await applyTaskEdit(ctx, task.id, [
    { op: "check", collection: "acceptanceCriteria", id: aId },
  ]);
  await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "acceptanceCriteria", text: "A" },
  ]);

  const full = await getTaskFull(ctx, task.id);
  expect(full.acceptanceCriteria.map((c) => c.text)).toEqual(["A", "B"]);
  const a = full.acceptanceCriteria.find((c) => c.text === "A");
  expect(a?.id).toBe(aId);
  expect(a?.checked).toBe(true);

  const rows = await activityRows(task.id);
  expect(rows.filter((r) => r.type === "criterion_added").length).toBe(0);
  expect(rows.filter((r) => r.type === "criterion_unchecked").length).toBe(0);
});

test("criteria re-add with explicit checked:false unchecks a checked item", async () => {
  const f = await seedUserOrgProject("crit-readd-uncheck");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    acceptanceCriteria: ["A"],
  });
  const before = await getTaskFull(ctx, task.id);
  const aId = before.acceptanceCriteria[0].id;

  await applyTaskEdit(ctx, task.id, [
    { op: "check", collection: "acceptanceCriteria", id: aId },
  ]);
  await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "acceptanceCriteria", text: "A", checked: false },
  ]);

  const full = await getTaskFull(ctx, task.id);
  const a = full.acceptanceCriteria.find((c) => c.text === "A");
  expect(a?.id).toBe(aId);
  expect(a?.checked).toBe(false);

  const rows = await activityRows(task.id);
  expect(rows.filter((r) => r.type === "criterion_unchecked").length).toBe(1);
  expect(rows.filter((r) => r.type === "criterion_added").length).toBe(0);
});

test("decision re-add preserves source and date and emits no new event", async () => {
  const f = await seedUserOrgProject("decision-readd");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "decisions", text: "D1" },
  ]);
  const before = await getTaskFull(ctx, task.id);
  expect(before.decisions.length).toBe(1);
  const d = before.decisions[0];

  await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "decisions", text: "D1" },
  ]);
  const after = await getTaskFull(ctx, task.id);
  expect(after.decisions.length).toBe(1);
  expect(after.decisions[0].id).toBe(d.id);
  expect(after.decisions[0].source).toBe(d.source);
  expect(after.decisions[0].date).toBe(d.date);

  const rows = await activityRows(task.id);
  expect(rows.filter((r) => r.type === "decision_added").length).toBe(1);
});

test("link update to another link's url raises DuplicateLinkUrlError", async () => {
  const f = await seedUserOrgProject("link-dup");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "links", url: "https://github.com/o/r/pull/1" },
    { op: "add", collection: "links", url: "https://github.com/o/r/pull/2" },
  ]);
  const full = await getTaskFull(ctx, task.id);
  const second = full.links.find(
    (l) => l.url === "https://github.com/o/r/pull/2",
  );
  if (!second) throw new Error("expected the second link");

  const err = await applyTaskEdit(ctx, task.id, [
    {
      op: "update",
      collection: "links",
      id: second.id,
      url: "https://github.com/o/r/pull/1",
    },
  ]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DuplicateLinkUrlError);
});

test("by-id ops reject a non-UUID id before any query", async () => {
  const f = await seedUserOrgProject("uuid-guard");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "base",
  });

  const ops = [
    { op: "remove", collection: "acceptanceCriteria", id: "bogus-id" },
    { op: "check", collection: "acceptanceCriteria", id: "bogus-id" },
    { op: "update", collection: "decisions", id: "bogus-id", text: "x" },
    { op: "remove", collection: "links", id: "bogus-id" },
  ] as const;
  for (const op of ops) {
    const err = await applyTaskEdit(ctx, task.id, [
      op as unknown as Parameters<typeof applyTaskEdit>[2][number],
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidEditOpError);
    expect((err as Error).message).toContain("not an item UUID");
  }
});

test("assignee ops reject a value that is neither 'me' nor a UUID", async () => {
  const f = await seedUserOrgProject("assignee-shape");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "base",
  });

  const err = await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "assignees", value: "not-a-uuid" },
  ]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(InvalidEditOpError);
  expect((err as Error).message).toContain("'me' or a user UUID");
});

test("set title and set description reject empty text", async () => {
  const f = await seedUserOrgProject("empty-set");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "base",
  });

  await expect(
    applyTaskEdit(ctx, task.id, [{ op: "set", field: "title", value: "  " }]),
  ).rejects.toBeInstanceOf(InvalidEditOpError);
  await expect(
    applyTaskEdit(ctx, task.id, [
      { op: "set", field: "description", text: "  " },
    ]),
  ).rejects.toBeInstanceOf(InvalidEditOpError);
});

test("malformed ifUpdatedAt is a validation error, not a stale write", async () => {
  const f = await seedUserOrgProject("bad-cas");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "base",
  });

  const err = await applyTaskEdit(
    ctx,
    task.id,
    [{ op: "set", field: "priority", value: "core" }],
    "not-a-timestamp",
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(InvalidEditOpError);
  expect((err as Error).message).toContain("not a valid timestamp");
});

test("set category outside the project vocabulary is rejected with the vocabulary", async () => {
  const f = await seedUserOrgProject("cat-vocab");
  const ctx = makeAuthContext(f.userId);
  const sql = superuserPool();
  await sql`
    UPDATE projects SET categories = ${JSON.stringify(["backend", "mcp"])}::jsonb
    WHERE id = ${f.projectId}`;
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "base",
  });

  const err = await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "category", value: "zzz_invalid" },
  ]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UnknownCategoryError);
  expect((err as UnknownCategoryError).vocabulary).toEqual(["backend", "mcp"]);

  const res = asEdit(
    await applyTaskEdit(ctx, task.id, [
      { op: "set", field: "category", value: "mcp" },
    ]),
  );
  expect(res.category).toBe("mcp");
});

test("set category passes freely when the vocabulary is empty", async () => {
  const f = await seedUserOrgProject("cat-empty");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "base",
  });

  const res = asEdit(
    await applyTaskEdit(ctx, task.id, [
      { op: "set", field: "category", value: "anything" },
    ]),
  );
  expect(res.category).toBe("anything");
});

test("link add honors label and kind overrides and rejects unknown kinds", async () => {
  const f = await seedUserOrgProject("link-meta");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "base",
  });

  await applyTaskEdit(ctx, task.id, [
    {
      op: "add",
      collection: "links",
      url: "https://example.com/spec",
      kind: "doc",
      label: "Design doc",
    },
  ]);
  const full = await getTaskFull(ctx, task.id);
  const link = full.links.find((l) => l.url.includes("example.com"));
  expect(link?.kind).toBe("doc");
  expect(link?.label).toBe("Design doc");

  const err = await applyTaskEdit(ctx, task.id, [
    {
      op: "add",
      collection: "links",
      url: "https://example.com/other",
      kind: "bogus",
    },
  ]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(InvalidEditOpError);
  expect((err as Error).message).toContain(
    "pull_request, issue, commit, doc, link",
  );
});

test("malformed link and prUrl values raise InvalidLinkUrlError", async () => {
  const f = await seedUserOrgProject("bad-url");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "base",
  });

  const linkErr = await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "links", url: "not a url" },
  ]).catch((e: unknown) => e);
  expect(linkErr).toBeInstanceOf(InvalidLinkUrlError);

  const prErr = await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "prUrl", value: "not a url" },
  ]).catch((e: unknown) => e);
  expect(prErr).toBeInstanceOf(InvalidLinkUrlError);
});

test("concurrent edits with the same ifUpdatedAt serialize to one winner", async () => {
  const f = await seedUserOrgProject("cas-race");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "base",
  });
  const r0 = asEdit(
    await applyTaskEdit(ctx, task.id, [
      { op: "set", field: "priority", value: "normal" },
    ]),
  );
  const stamp = r0.updatedAt.toISOString();

  const results = await Promise.allSettled([
    applyTaskEdit(
      ctx,
      task.id,
      [{ op: "set", field: "priority", value: "urgent" }],
      stamp,
    ),
    applyTaskEdit(
      ctx,
      task.id,
      [{ op: "set", field: "priority", value: "backlog" }],
      stamp,
    ),
  ]);

  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason).toBeInstanceOf(StaleWriteError);
});

test("ifUpdatedAt is rejected on delete_task", async () => {
  const f = await seedUserOrgProject("del-cas");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const err = await applyTaskEdit(
    ctx,
    task.id,
    [{ op: "delete_task" }],
    new Date().toISOString(),
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(InvalidEditOpError);
  expect((err as Error).message).toContain("delete_task");
});

test("every category op in a multi-op call is validated", async () => {
  const f = await seedUserOrgProject("cat-multi");
  const ctx = makeAuthContext(f.userId);
  const sql = superuserPool();
  await sql`
    UPDATE projects SET categories = ${JSON.stringify(["backend", "mcp"])}::jsonb
    WHERE id = ${f.projectId}`;
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "base",
  });

  const err = await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "category", value: "backend" },
    { op: "set", field: "category", value: "zzz_invalid" },
  ]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UnknownCategoryError);
});

test("link update patches only the supplied fields", async () => {
  const f = await seedUserOrgProject("link-patch");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await applyTaskEdit(ctx, task.id, [
    {
      op: "add",
      collection: "links",
      url: "https://example.com/spec",
      kind: "doc",
      label: "Design doc",
    },
  ]);
  let full = await getTaskFull(ctx, task.id);
  const linkId = full.links[0].id;

  await applyTaskEdit(ctx, task.id, [
    {
      op: "update",
      collection: "links",
      id: linkId,
      url: "https://example.com/spec-v2",
    },
  ]);
  full = await getTaskFull(ctx, task.id);
  expect(full.links[0].url).toBe("https://example.com/spec-v2");
  expect(full.links[0].kind).toBe("doc");
  expect(full.links[0].label).toBe("Design doc");

  const err = await applyTaskEdit(ctx, task.id, [
    { op: "update", collection: "links", id: linkId },
  ]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(InvalidEditOpError);
  expect((err as Error).message).toContain("at least one of");
});

test("criteria and decision text is trimmed and must be non-empty", async () => {
  const f = await seedUserOrgProject("trim");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const res = asEdit(
    await applyTaskEdit(ctx, task.id, [
      { op: "add", collection: "acceptanceCriteria", text: "  padded  " },
      { op: "add", collection: "decisions", text: "  chose X  " },
    ]),
  );
  expect(res.acceptanceCriteria?.[0].text).toBe("padded");
  expect(res.decisions?.[0].text).toBe("chose X");

  const err = await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "decisions", text: "   " },
  ]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(InvalidEditOpError);
});
