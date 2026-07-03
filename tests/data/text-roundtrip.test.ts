import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { createTask, getTaskFields } from "@/lib/data/task";
import { applyTaskEdit } from "@/lib/data/task-edit";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

/**
 * Text that must survive storage byte-identically: code identifiers,
 * globs, inline code, raw HTML, and injection-shaped strings. Stored as
 * written (trim only); XSS defense lives at render (rehype-sanitize) and
 * SQL safety in parameterized queries.
 */
const HOSTILE_TEXT = [
  "identifiers like user_id and get_connection_string must round-trip",
  "globs *.ts and **/fixtures/*.sql stay literal",
  "inline `code_span` and __dunder__ and snake_case_name",
  '<script>alert(1)</script> stays inert text',
  "'; DROP TABLE tasks;-- and ${jndi:ldap://x} store literally",
].join("\n\n");

test("description round-trips byte-identically through create and fields read", async () => {
  const f = await seedUserOrgProject("rt-create");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "Round trip",
    description: HOSTILE_TEXT,
  });

  const row = await getTaskFields(ctx, task.id, ["description"]);
  expect(row.description).toBe(HOSTILE_TEXT);
});

test("append and set round-trip byte-identically through piyaz_edit ops", async () => {
  const f = await seedUserOrgProject("rt-edit");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "Round trip",
    description: "base",
  });

  await applyTaskEdit(ctx, task.id, [
    { op: "append", field: "description", text: HOSTILE_TEXT },
    { op: "set", field: "implementationPlan", text: HOSTILE_TEXT },
  ]);

  const row = await getTaskFields(ctx, task.id, [
    "description",
    "implementationPlan",
  ]);
  expect(row.description).toBe(`base\n\n${HOSTILE_TEXT}`);
  expect(row.implementation_plan).toBe(HOSTILE_TEXT);
});

test("str_replace matches the exact text a prior write stored", async () => {
  const f = await seedUserOrgProject("rt-replace");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "Round trip",
    description: "call get_user_by_id() in lib/db/*.ts",
  });

  await applyTaskEdit(ctx, task.id, [
    {
      op: "str_replace",
      field: "description",
      oldStr: "get_user_by_id() in lib/db/*.ts",
      newStr: "get_user_by_id() in lib/db/raw/*.ts",
    },
  ]);

  const row = await getTaskFields(ctx, task.id, ["description"]);
  expect(row.description).toBe("call get_user_by_id() in lib/db/raw/*.ts");
});

test("criteria and decisions text stores unescaped", async () => {
  const f = await seedUserOrgProject("rt-children");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "Round trip",
    description: "base",
    acceptanceCriteria: ["user_id column is indexed on *.ts reads"],
    decisions: ["use snake_case_name because __init__ conventions"],
  });

  const row = await getTaskFields(ctx, task.id, [
    "acceptanceCriteria",
    "decisions",
  ]);
  expect(row.acceptance_criteria?.[0].text).toBe(
    "user_id column is indexed on *.ts reads",
  );
  expect(row.decisions?.[0].text).toBe(
    "use snake_case_name because __init__ conventions",
  );
});
