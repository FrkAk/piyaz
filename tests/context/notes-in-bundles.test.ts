import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { serviceRoleConnect } from "@/tests/setup/seed";
import { seedRichContextTask } from "./fixtures";
import {
  resolveAgentBundleData,
  resolvePlanningData,
  resolveRecordData,
  resolveReviewData,
  resolveSummaryData,
  resolveWorkingData,
} from "@/lib/context/_core/bundle";
import {
  buildAgentContextFrom,
  buildAgentContextParts,
} from "@/lib/context/_core/agent";
import { buildPlanningContextParts } from "@/lib/context/_core/planning";
import { buildReviewContextParts } from "@/lib/context/_core/review";
import {
  buildWorkingContextFrom,
  formatWorkingContextParts,
} from "@/lib/context/_core/working";
import { buildRecordContextParts } from "@/lib/context/_core/record";
import { buildSummaryContext } from "@/lib/context/_core/summary";
import { formatSummary } from "@/lib/graph/format-responses";
import { joinParts } from "@/lib/context/parts";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

/**
 * Seed one note per exposure case against the rich-context central task
 * (category `feature`, tags `alpha`/`beta`): a category-matched guidance
 * note, an all-mode reference note, a tag-matched knowledge note, a
 * `feed_mode='none'` note, and a private note. Feed labels insert in the
 * canonical lowercase form the write path stores.
 *
 * @param projectId - Project owning the notes.
 */
async function seedFeedNotes(projectId: string) {
  const sr = serviceRoleConnect();
  try {
    await sr`
      INSERT INTO notes
        (project_id, title, slug, visibility, type, body, summary,
         feed_mode, feed_categories, feed_tags)
      VALUES
        (${projectId}, 'Lint gate', 'lint-gate', 'team', 'guidance',
         'Always run bun lint before commit.', 'lint rule',
         'categories', '["feature"]'::jsonb, '[]'::jsonb),
        (${projectId}, 'API map', 'api-map', 'team', 'reference',
         'Endpoints live in app/api.', 'endpoint index',
         'all', '[]'::jsonb, '[]'::jsonb),
        (${projectId}, 'Tag guide', 'tag-guide', 'team', 'knowledge',
         'Alpha tag semantics.', 'alpha semantics',
         'tags', '[]'::jsonb, '["alpha"]'::jsonb),
        (${projectId}, 'Hidden', 'hidden-note', 'team', 'guidance',
         'Never surfaced.', 'unfed', 'none', '[]'::jsonb, '[]'::jsonb),
        (${projectId}, 'Private', 'private-note', 'private', 'guidance',
         'Mine only.', 'secret', 'all', '[]'::jsonb, '[]'::jsonb)
    `;
  } finally {
    await sr.end({ timeout: 5 });
  }
}

/** Titles every matched-feed resolution must contain, and nothing else. */
const MATCHED_TITLES = ["API map", "Lint gate", "Tag guide"];

test("deep resolvers thread matched notes with bounded guidance bodies", async () => {
  const fx = await seedRichContextTask("notes-deep");
  const { task } = await resolveWorkingData(fx.userId, fx.taskId);
  await seedFeedNotes(task.projectId);

  const agent = await resolveAgentBundleData(fx.userId, fx.taskId);
  expect(agent.kind).toBe("agent");
  if (agent.kind !== "agent") throw new Error("unreachable");
  const planning = await resolvePlanningData(fx.userId, fx.taskId);
  const review = await resolveReviewData(fx.userId, fx.taskId);

  for (const feed of [agent.data.feed, planning.feed, review.feed]) {
    expect(feed.notes.map((n) => n.title).sort()).toEqual(MATCHED_TITLES);
    const byTitle = new Map(feed.notes.map((n) => [n.title, n]));
    expect(byTitle.get("Lint gate")?.body).toBe(
      "Always run bun lint before commit.",
    );
    expect(byTitle.get("API map")?.body).toBe("");
    expect(byTitle.get("Tag guide")?.body).toBe("");
    for (const row of feed.notes) {
      expect(row.noteRef).toMatch(/^PRJ.+-N\d+$/);
    }
    expect(feed.overflow).toEqual([]);
    expect(feed.truncated).toBe(false);
  }
});

test("slim resolvers thread pointer-only notes without bodies", async () => {
  const fx = await seedRichContextTask("notes-slim");
  const { task } = await resolveWorkingData(fx.userId, fx.taskId);
  await seedFeedNotes(task.projectId);

  const working = await resolveWorkingData(fx.userId, fx.taskId);
  expect(working.feed.notes.map((n) => n.title).sort()).toEqual(MATCHED_TITLES);
  expect(working.feed.notes.every((n) => n.body === "")).toBe(true);

  const summary = await resolveSummaryData(fx.userId, fx.taskId);
  expect(summary.feed.notes.map((n) => n.title).sort()).toEqual(MATCHED_TITLES);
  expect(summary.feed.notes.every((n) => n.body === "")).toBe(true);
});

test("record resolver and agent terminal dispatch thread slim notes", async () => {
  const fx = await seedRichContextTask("notes-record");
  const { task } = await resolveWorkingData(fx.userId, fx.taskId);
  await seedFeedNotes(task.projectId);
  const sr = serviceRoleConnect();
  try {
    await sr`UPDATE tasks SET status = 'done' WHERE id = ${fx.taskId}`;
  } finally {
    await sr.end({ timeout: 5 });
  }

  const record = await resolveRecordData(fx.userId, fx.taskId);
  expect(record.feed.notes.map((n) => n.title).sort()).toEqual(MATCHED_TITLES);
  expect(record.feed.notes.every((n) => n.body === "")).toBe(true);

  const terminal = await resolveAgentBundleData(fx.userId, fx.taskId);
  expect(terminal.kind).toBe("record");
  if (terminal.kind !== "record") throw new Error("unreachable");
  expect(terminal.data.feed.notes.map((n) => n.title).sort()).toEqual(
    MATCHED_TITLES,
  );
  expect(terminal.data.feed.notes.every((n) => n.body === "")).toBe(true);
});

test("deep bundles render Project Guidance and Relevant Notes in position", async () => {
  const fx = await seedRichContextTask("notes-render");
  const { task } = await resolveWorkingData(fx.userId, fx.taskId);
  await seedFeedNotes(task.projectId);

  const agent = await resolveAgentBundleData(fx.userId, fx.taskId);
  expect(agent.kind).toBe("agent");
  if (agent.kind !== "agent") throw new Error("unreachable");
  const agentParts = buildAgentContextParts(agent.data);
  const agentIds = agentParts.map((p) => p.id as string);
  expect(agentIds.indexOf("guidance")).toBeGreaterThan(-1);
  expect(agentIds.indexOf("guidance")).toBeLessThan(agentIds.indexOf("plan"));
  expect(agentIds.indexOf("notes")).toBeGreaterThan(
    agentIds.indexOf("downstream"),
  );
  expect(agentIds.indexOf("notes")).toBeLessThan(agentIds.indexOf("related"));
  const agentText = joinParts(agentParts);
  expect(agentText).toContain("## Project Guidance");
  expect(agentText).toMatch(/### `[^`]+-N\d+` Lint gate/);
  expect(agentText).toContain("> Always run bun lint before commit.");
  expect(agentText).toContain("[reference] API map — endpoint index");
  expect(agentText).toContain("piyaz_note action='read'");
  expect(agentText).not.toContain("Endpoints live in app/api.");
  expect(agentText).not.toContain("Never surfaced.");
  expect(agentText).not.toContain("Mine only.");

  const planningParts = buildPlanningContextParts(
    await resolvePlanningData(fx.userId, fx.taskId),
  );
  const planIds = planningParts.map((p) => p.id as string);
  expect(planIds.indexOf("guidance")).toBeGreaterThan(
    planIds.indexOf("project"),
  );
  expect(planIds.indexOf("guidance")).toBeLessThan(planIds.indexOf("spec"));
  expect(planIds.indexOf("notes")).toBeGreaterThan(
    planIds.indexOf("downstream"),
  );
  expect(planIds.indexOf("notes")).toBeLessThan(planIds.indexOf("related"));
  expect(joinParts(planningParts)).toContain(
    "> Always run bun lint before commit.",
  );

  const reviewParts = buildReviewContextParts(
    await resolveReviewData(fx.userId, fx.taskId),
  );
  const reviewIds = reviewParts.map((p) => p.id as string);
  expect(reviewIds.indexOf("guidance")).toBeGreaterThan(
    reviewIds.indexOf("project"),
  );
  expect(reviewIds.indexOf("guidance")).toBeLessThan(reviewIds.indexOf("spec"));
  expect(reviewIds.indexOf("notes")).toBeGreaterThan(
    reviewIds.indexOf("downstream"),
  );
  expect(reviewIds.indexOf("notes")).toBeLessThan(reviewIds.indexOf("lens"));
  expect(joinParts(reviewParts)).toContain(
    "> Always run bun lint before commit.",
  );
});

test("slim bundles render every matched note as a pointer, never a body", async () => {
  const fx = await seedRichContextTask("notes-slim-render");
  const { task } = await resolveWorkingData(fx.userId, fx.taskId);
  await seedFeedNotes(task.projectId);

  const working = await resolveWorkingData(fx.userId, fx.taskId);
  const workingParts = formatWorkingContextParts(
    buildWorkingContextFrom(working),
  );
  expect(workingParts[workingParts.length - 1].id as string).toBe("notes");
  const workingText = joinParts(workingParts);
  expect(workingText).toContain("[guidance] Lint gate — lint rule");
  expect(workingText).not.toContain("Always run bun lint before commit.");
  expect(workingText).not.toContain("## Project Guidance");

  const summaryText = formatSummary(
    await buildSummaryContext(makeAuthContext(fx.userId), fx.taskId),
  );
  expect(summaryText).toContain("## Relevant Notes");
  expect(summaryText).toContain("[knowledge] Tag guide — alpha semantics");
  expect(summaryText).not.toContain("Always run bun lint before commit.");

  const sr = serviceRoleConnect();
  try {
    await sr`UPDATE tasks SET status = 'done' WHERE id = ${fx.taskId}`;
  } finally {
    await sr.end({ timeout: 5 });
  }
  const recordParts = buildRecordContextParts(
    await resolveRecordData(fx.userId, fx.taskId),
  );
  expect(recordParts.map((p) => p.id as string)).toContain("notes");
  const recordText = joinParts(recordParts);
  expect(recordText).toContain("[guidance] Lint gate — lint rule");
  expect(recordText).not.toContain("## Project Guidance");
});

test("note-task backlinks of any kind surface as summary pointers; private links stay hidden", async () => {
  const fx = await seedRichContextTask("notes-backlink");
  const { task } = await resolveWorkingData(fx.userId, fx.taskId);
  const sr = serviceRoleConnect();
  try {
    const [teamNote] = await sr`
      INSERT INTO notes
        (project_id, title, slug, visibility, type, body, summary, feed_mode)
      VALUES
        (${task.projectId}, 'Linked spec', 'linked-spec', 'team', 'reference',
         'Spec body detail.', 'the spec', 'none')
      RETURNING id
    `;
    const [mentionNote] = await sr`
      INSERT INTO notes
        (project_id, title, slug, visibility, type, body, summary, feed_mode)
      VALUES
        (${task.projectId}, 'Mentioned doc', 'mentioned-doc', 'team',
         'knowledge', 'Mention body.', 'a mention', 'none')
      RETURNING id
    `;
    const [privateNote] = await sr`
      INSERT INTO notes
        (project_id, title, slug, visibility, type, body, summary, feed_mode)
      VALUES
        (${task.projectId}, 'Private linked', 'private-linked', 'private',
         'reference', 'Secret spec.', 'hidden', 'none')
      RETURNING id
    `;
    await sr`
      INSERT INTO note_task_links (note_id, task_id, kind) VALUES
        (${teamNote.id}, ${fx.taskId}, 'spec_of'),
        (${mentionNote.id}, ${fx.taskId}, 'mention'),
        (${privateNote.id}, ${fx.taskId}, 'spec_of')
    `;
  } finally {
    await sr.end({ timeout: 5 });
  }

  const agent = await resolveAgentBundleData(fx.userId, fx.taskId);
  expect(agent.kind).toBe("agent");
  if (agent.kind !== "agent") throw new Error("unreachable");
  const planning = await resolvePlanningData(fx.userId, fx.taskId);

  for (const feed of [agent.data.feed, planning.feed]) {
    expect(feed.linked.map((n) => n.title)).toEqual([
      "Linked spec",
      "Mentioned doc",
    ]);
    expect(feed.notes.map((n) => n.title)).not.toContain("Linked spec");
  }

  const agentText = joinParts(buildAgentContextParts(agent.data));
  expect(agentText).toContain("## Relevant Notes");
  expect(agentText).toMatch(/\[reference\] Linked spec — the spec/);
  expect(agentText).toMatch(/\[knowledge\] Mentioned doc — a mention/);
  expect(agentText).not.toContain("Spec body detail.");
  expect(agentText).not.toContain("Private linked");
  expect(agentText).not.toContain("Secret spec.");
});

test("an over-budget guidance body degrades every matched note to pointers", async () => {
  const fx = await seedRichContextTask("notes-overflow");
  const { task } = await resolveWorkingData(fx.userId, fx.taskId);
  const sr = serviceRoleConnect();
  try {
    await sr`
      INSERT INTO notes
        (project_id, title, slug, visibility, type, body, summary, feed_mode, updated_at)
      VALUES
        (${task.projectId}, 'Small guide', 'small-guide', 'team', 'guidance',
         'Tiny rule.', 'small', 'all', now() - interval '1 minute'),
        (${task.projectId}, 'Huge guide', 'huge-guide', 'team', 'guidance',
         ${"word ".repeat(1700)}, 'giant', 'all', now())
    `;
  } finally {
    await sr.end({ timeout: 5 });
  }

  const agent = await resolveAgentBundleData(fx.userId, fx.taskId);
  expect(agent.kind).toBe("agent");
  if (agent.kind !== "agent") throw new Error("unreachable");
  const text = buildAgentContextFrom(agent.data);
  expect(text).not.toContain("## Project Guidance");
  expect(text).toContain("## Relevant Notes");
  expect(text).toContain("Huge guide");
  expect(text).toContain("Small guide");
  expect(text).not.toContain("word word");
});
