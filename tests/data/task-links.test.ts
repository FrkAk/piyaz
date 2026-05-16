import { test, expect, afterEach } from "bun:test";
import postgres from "postgres";
import { truncateAll } from "@/tests/setup/schema";
import { getConnectionString } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import {
  createTask,
  deleteTask,
  updateTask,
  addTaskLink,
  removeTaskLink,
  updateTaskLink,
  fetchLinksUnchecked,
  getTaskFull,
} from "@/lib/data/task";
import { ForbiddenError } from "@/lib/auth/authorization";
import { buildAgentContext } from "@/lib/context/_core/agent";
import { buildWorkingContext } from "@/lib/context/_core/working";
import { buildSummaryContext } from "@/lib/context/_core/summary";
import { buildReviewContext } from "@/lib/context/_core/review";
import { withUserContext } from "@/lib/db/rls";

/**
 * Read links for a task as a specific user. Mirrors the production call
 * pattern: `fetchLinksUnchecked` is invoked inside a `withUserContext`
 * frame so RLS scoping is exercised exactly as in prod.
 */
function linksAs(taskId: string, userId: string) {
  return withUserContext(userId, (tx) => fetchLinksUnchecked(taskId, tx));
}

afterEach(async () => {
  await truncateAll();
});

// ---------------------------------------------------------------------------
// Security: cross-team isolation and input validation
// ---------------------------------------------------------------------------

test("addTaskLink raises ForbiddenError for callers outside the task's team", async () => {
  const owner = await seedUserOrgProject("links-add-x1");
  const stranger = await seedUserOrgProject("links-add-x2");
  const ownerCtx = makeAuthContext(owner.userId);
  const strangerCtx = makeAuthContext(stranger.userId);
  const task = await createTask(ownerCtx, { projectId: owner.projectId, title: "T" });

  await expect(
    addTaskLink(strangerCtx, task.id, "https://github.com/o/r/pull/1"),
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("removeTaskLink raises ForbiddenError for callers outside the task's team", async () => {
  const owner = await seedUserOrgProject("links-rm-x1");
  const stranger = await seedUserOrgProject("links-rm-x2");
  const ownerCtx = makeAuthContext(owner.userId);
  const strangerCtx = makeAuthContext(stranger.userId);
  const task = await createTask(ownerCtx, { projectId: owner.projectId, title: "T" });
  const link = await addTaskLink(ownerCtx, task.id, "https://github.com/o/r/pull/2");

  await expect(removeTaskLink(strangerCtx, link.id)).rejects.toBeInstanceOf(
    ForbiddenError,
  );

  const remaining = await linksAs(task.id, owner.userId);
  expect(remaining.length).toBe(1);
});

test("removeTaskLink raises ForbiddenError for a non-existent linkId (no enumeration)", async () => {
  const f = await seedUserOrgProject("links-rm-missing");
  const ctx = makeAuthContext(f.userId);

  await expect(
    removeTaskLink(ctx, "00000000-0000-0000-0000-000000000000"),
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("addTaskLink rejects malformed URLs as ForbiddenError (input validation)", async () => {
  const f = await seedUserOrgProject("links-bad-url");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await expect(addTaskLink(ctx, task.id, "not a url")).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await expect(addTaskLink(ctx, task.id, "")).rejects.toBeInstanceOf(
    ForbiddenError,
  );

  expect((await linksAs(task.id, f.userId)).length).toBe(0);
});

test("addTaskLink rejects non-http(s) protocols (XSS-in-href guard)", async () => {
  const f = await seedUserOrgProject("links-bad-proto");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await expect(
    addTaskLink(ctx, task.id, "javascript:alert(1)"),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    addTaskLink(ctx, task.id, "data:text/html,<script>alert(1)</script>"),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    addTaskLink(ctx, task.id, "file:///etc/passwd"),
  ).rejects.toBeInstanceOf(ForbiddenError);

  expect((await linksAs(task.id, f.userId)).length).toBe(0);
});

test("updateTask with malformed or unsafe prUrl raises ForbiddenError before persisting", async () => {
  const f = await seedUserOrgProject("links-bad-prurl");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await expect(
    updateTask(ctx, task.id, { prUrl: "not a url" }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    updateTask(ctx, task.id, { prUrl: "javascript:alert(1)" }),
  ).rejects.toBeInstanceOf(ForbiddenError);

  expect((await linksAs(task.id, f.userId)).length).toBe(0);
});

// ---------------------------------------------------------------------------
// Reliability: idempotency, transactional safety, cascade behavior
// ---------------------------------------------------------------------------

test("addTaskLink normalizes scheme-less input and stores the canonical URL", async () => {
  const f = await seedUserOrgProject("links-normalize-add");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await addTaskLink(ctx, task.id, "github.com/anthropic/claude/pull/42");
  const rows = await linksAs(task.id, f.userId);

  expect(rows.length).toBe(1);
  expect(rows[0].url).toBe("https://github.com/anthropic/claude/pull/42");
  expect(rows[0].kind).toBe("pull_request");
});

test("addTaskLink dedupes scheme-less + canonical inputs of the same URL", async () => {
  const f = await seedUserOrgProject("links-normalize-dedup");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const first = await addTaskLink(ctx, task.id, "github.com/o/r/pull/1");
  const second = await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/1");

  expect(second.id).toBe(first.id);
  expect((await linksAs(task.id, f.userId)).length).toBe(1);
});

test("updateTaskLink rewrites the URL in place and preserves id and createdAt", async () => {
  const f = await seedUserOrgProject("links-edit");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  const original = await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/1");

  const updated = await updateTaskLink(ctx, original.id, "github.com/o/r/issues/2");

  expect(updated.id).toBe(original.id);
  expect(updated.createdAt.toISOString()).toBe(original.createdAt.toISOString());
  expect(updated.url).toBe("https://github.com/o/r/issues/2");
  expect(updated.kind).toBe("issue");
});

test("updateTaskLink raises ForbiddenError for callers outside the task's team", async () => {
  const owner = await seedUserOrgProject("links-edit-x1");
  const stranger = await seedUserOrgProject("links-edit-x2");
  const ownerCtx = makeAuthContext(owner.userId);
  const strangerCtx = makeAuthContext(stranger.userId);
  const task = await createTask(ownerCtx, { projectId: owner.projectId, title: "T" });
  const link = await addTaskLink(ownerCtx, task.id, "https://github.com/o/r/pull/1");

  await expect(
    updateTaskLink(strangerCtx, link.id, "https://github.com/o/r/pull/2"),
  ).rejects.toBeInstanceOf(ForbiddenError);

  const rows = await linksAs(task.id, owner.userId);
  expect(rows[0].url).toBe("https://github.com/o/r/pull/1");
});

test("updateTaskLink rejects a malformed URL and leaves the row untouched", async () => {
  const f = await seedUserOrgProject("links-edit-bad-url");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  const link = await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/1");

  await expect(updateTaskLink(ctx, link.id, "javascript:alert(1)")).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await expect(updateTaskLink(ctx, link.id, "not a url")).rejects.toBeInstanceOf(
    ForbiddenError,
  );

  const rows = await linksAs(task.id, f.userId);
  expect(rows[0].url).toBe("https://github.com/o/r/pull/1");
});

test("updateTaskLink raises ForbiddenError when the new URL collides with another link on the same task", async () => {
  const f = await seedUserOrgProject("links-edit-collide");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/1");
  const second = await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/2");

  await expect(
    updateTaskLink(ctx, second.id, "https://github.com/o/r/pull/1"),
  ).rejects.toBeInstanceOf(ForbiddenError);

  const rows = await linksAs(task.id, f.userId);
  expect(rows.length).toBe(2);
  const urls = rows.map((r) => r.url).sort();
  expect(urls).toEqual([
    "https://github.com/o/r/pull/1",
    "https://github.com/o/r/pull/2",
  ]);
});

test("updateTaskLink is a no-op when the new URL equals the current canonical URL", async () => {
  const f = await seedUserOrgProject("links-edit-noop");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  const link = await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/1");

  const updated = await updateTaskLink(ctx, link.id, "github.com/o/r/pull/1");

  expect(updated.id).toBe(link.id);
  expect(updated.url).toBe("https://github.com/o/r/pull/1");
});

test("addTaskLink is idempotent: re-adding the same URL returns the existing row", async () => {
  const f = await seedUserOrgProject("links-idem");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const first = await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/1");
  const second = await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/1");

  expect(second.id).toBe(first.id);
  const rows = await linksAs(task.id, f.userId);
  expect(rows.length).toBe(1);
});

test("unique(taskId, url) allows the same URL across different tasks", async () => {
  const f = await seedUserOrgProject("links-cross-task");
  const ctx = makeAuthContext(f.userId);
  const a = await createTask(ctx, { projectId: f.projectId, title: "A" });
  const b = await createTask(ctx, { projectId: f.projectId, title: "B" });
  const sharedUrl = "https://github.com/o/r/pull/9";

  await addTaskLink(ctx, a.id, sharedUrl);
  await addTaskLink(ctx, b.id, sharedUrl);

  expect((await linksAs(a.id, f.userId)).length).toBe(1);
  expect((await linksAs(b.id, f.userId)).length).toBe(1);
});

test("updateTask prUrl=null deletes only the pull_request row, preserves other kinds", async () => {
  const f = await seedUserOrgProject("links-clear-pr");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await updateTask(ctx, task.id, { prUrl: "https://github.com/o/r/pull/1" });
  await addTaskLink(ctx, task.id, "https://github.com/o/r/issues/2");
  await addTaskLink(ctx, task.id, "https://www.notion.so/Some-doc-abc");
  expect((await linksAs(task.id, f.userId)).length).toBe(3);

  await updateTask(ctx, task.id, { prUrl: null });

  const remaining = await linksAs(task.id, f.userId);
  const kinds = remaining.map((l) => l.kind).sort();
  expect(kinds).toEqual(["doc", "issue"]);
});

test("updateTask with the same prUrl twice is idempotent (handles composer retry)", async () => {
  const f = await seedUserOrgProject("links-prurl-retry");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  const pr = "https://github.com/o/r/pull/7";

  await updateTask(ctx, task.id, { prUrl: pr });
  await updateTask(ctx, task.id, { prUrl: pr });

  const rows = await linksAs(task.id, f.userId);
  expect(rows.length).toBe(1);
  expect(rows[0].kind).toBe("pull_request");
  expect(rows[0].url).toBe(pr);
});

test("deleting a task cascades and removes its task_links rows", async () => {
  const f = await seedUserOrgProject("links-cascade");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/1");
  await addTaskLink(ctx, task.id, "https://github.com/o/r/issues/2");

  await deleteTask(ctx, task.id);

  const sql = postgres(getConnectionString(), { max: 1 });
  try {
    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM task_links WHERE task_id = ${task.id}
    `;
    expect(rows[0].count).toBe(0);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

// ---------------------------------------------------------------------------
// Consistency: ordering, surfacing through the read path
// ---------------------------------------------------------------------------

test("fetchLinksUnchecked returns links ordered by createdAt ascending", async () => {
  const f = await seedUserOrgProject("links-order");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/1");
  await new Promise((r) => setTimeout(r, 15));
  await addTaskLink(ctx, task.id, "https://github.com/o/r/issues/2");
  await new Promise((r) => setTimeout(r, 15));
  await addTaskLink(ctx, task.id, "https://www.notion.so/Some-doc-abc");

  const rows = await linksAs(task.id, f.userId);
  expect(rows.map((r) => r.kind)).toEqual(["pull_request", "issue", "doc"]);
});

// ---------------------------------------------------------------------------
// Context builders: links must follow the same cross-team gate as the task
// ---------------------------------------------------------------------------

test("buildAgentContext denies cross-team callers, blocking any link leak", async () => {
  const owner = await seedUserOrgProject("ctx-agent-x1");
  const stranger = await seedUserOrgProject("ctx-agent-x2");
  const ownerCtx = makeAuthContext(owner.userId);
  const strangerCtx = makeAuthContext(stranger.userId);
  const task = await createTask(ownerCtx, { projectId: owner.projectId, title: "T" });
  await updateTask(ownerCtx, task.id, { prUrl: "https://github.com/o/r/pull/10" });

  await expect(buildAgentContext(strangerCtx, task.id)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
});

test("buildWorkingContext denies cross-team callers, blocking any link leak", async () => {
  const owner = await seedUserOrgProject("ctx-working-x1");
  const stranger = await seedUserOrgProject("ctx-working-x2");
  const ownerCtx = makeAuthContext(owner.userId);
  const strangerCtx = makeAuthContext(stranger.userId);
  const task = await createTask(ownerCtx, { projectId: owner.projectId, title: "T" });
  await updateTask(ownerCtx, task.id, { prUrl: "https://github.com/o/r/pull/11" });

  await expect(
    buildWorkingContext(strangerCtx, task.id),
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("buildSummaryContext denies cross-team callers, blocking any link leak", async () => {
  const owner = await seedUserOrgProject("ctx-summary-x1");
  const stranger = await seedUserOrgProject("ctx-summary-x2");
  const ownerCtx = makeAuthContext(owner.userId);
  const strangerCtx = makeAuthContext(stranger.userId);
  const task = await createTask(ownerCtx, { projectId: owner.projectId, title: "T" });
  await updateTask(ownerCtx, task.id, { prUrl: "https://github.com/o/r/pull/12" });

  await expect(
    buildSummaryContext(strangerCtx, task.id),
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("buildReviewContext denies cross-team callers, blocking any link leak", async () => {
  const owner = await seedUserOrgProject("ctx-review-x1");
  const stranger = await seedUserOrgProject("ctx-review-x2");
  const ownerCtx = makeAuthContext(owner.userId);
  const strangerCtx = makeAuthContext(stranger.userId);
  const task = await createTask(ownerCtx, { projectId: owner.projectId, title: "T" });
  await updateTask(ownerCtx, task.id, { prUrl: "https://github.com/o/r/pull/13" });

  await expect(
    buildReviewContext(strangerCtx, task.id),
  ).rejects.toBeInstanceOf(ForbiddenError);
});

// ---------------------------------------------------------------------------
// SSRF guard: link write/read paths must not network-fetch the stored URL
// ---------------------------------------------------------------------------

test("link write paths never fetch the supplied URL (SSRF guard)", async () => {
  const f = await seedUserOrgProject("links-ssrf-write");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const seen: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    seen.push(u);
    return originalFetch.call(globalThis, input, init);
  }) as typeof globalThis.fetch;

  try {
    await addTaskLink(ctx, task.id, "https://ssrf-canary-add.invalid/probe");
    await updateTask(ctx, task.id, {
      prUrl: "https://ssrf-canary-pr.invalid/probe",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(seen.filter((u) => u.includes("ssrf-canary"))).toEqual([]);
});

test("link read paths never fetch the stored URL (SSRF guard)", async () => {
  const f = await seedUserOrgProject("links-ssrf-read");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await addTaskLink(ctx, task.id, "https://ssrf-canary-read.invalid/probe");

  const seen: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    seen.push(u);
    return originalFetch.call(globalThis, input, init);
  }) as typeof globalThis.fetch;

  try {
    await linksAs(task.id, f.userId);
    await getTaskFull(ctx, task.id);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(seen.filter((u) => u.includes("ssrf-canary"))).toEqual([]);
});

test("context builders never fetch the stored link URL (SSRF guard)", async () => {
  const f = await seedUserOrgProject("links-ssrf-ctx");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await addTaskLink(ctx, task.id, "https://ssrf-canary-ctx.invalid/probe");

  const seen: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    seen.push(u);
    return originalFetch.call(globalThis, input, init);
  }) as typeof globalThis.fetch;

  try {
    await buildAgentContext(ctx, task.id);
    await buildWorkingContext(ctx, task.id);
    await buildSummaryContext(ctx, task.id);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(seen.filter((u) => u.includes("ssrf-canary"))).toEqual([]);
});

test("getTaskFull surfaces the links array on the read path", async () => {
  const f = await seedUserOrgProject("links-full");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await updateTask(ctx, task.id, { prUrl: "https://github.com/o/r/pull/3" });

  const full = await getTaskFull(ctx, task.id);

  expect(Array.isArray(full.links)).toBe(true);
  expect(full.links.length).toBe(1);
  expect(full.links[0].kind).toBe("pull_request");
  expect(full.links[0].url).toBe("https://github.com/o/r/pull/3");
});
