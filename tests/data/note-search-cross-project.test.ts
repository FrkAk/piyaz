import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedSecondMember, seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import {
  createNote,
  searchNotesAcrossProjects,
  updateNote,
  NoteValidationError,
} from "@/lib/data/note";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

/**
 * Add an org holding a project that reuses an existing identifier, with the
 * caller as a member. Identifiers are unique per org, not globally, so this
 * is the collision the ⌘K palette must render as one hit per org.
 *
 * @param userId - User joining the new org.
 * @param suffix - Unique suffix for the org name/slug.
 * @param identifier - Project identifier to reuse.
 * @returns The new org and project ids.
 */
async function seedOrgReusingIdentifier(
  userId: string,
  suffix: string,
  identifier: string,
): Promise<{ organizationId: string; projectId: string }> {
  const sql = superuserPool();
  const [o] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
    VALUES (${"Team " + suffix}, ${"team-" + suffix}, now())
    RETURNING id
  `;
  await sql`
    INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
    VALUES (${o.id}, ${userId}, 'member', now())
  `;
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO projects ("organization_id", "title", "identifier")
    VALUES (${o.id}, ${"Project " + suffix}, ${identifier})
    RETURNING id
  `;
  return { organizationId: o.id, projectId: p.id };
}

test("surfaces notes across projects and isolates other tenants", async () => {
  const f1 = await seedUserOrgProject("xnote1");
  const f2 = await seedUserOrgProject("xnote2");
  const ctx1 = makeAuthContext(f1.userId);
  const ctx2 = makeAuthContext(f2.userId);

  await createNote(ctx1, {
    projectId: f1.projectId,
    title: "Reddit shadowban checker",
    body: "spec",
    visibility: "team",
  });
  await createNote(ctx2, {
    projectId: f2.projectId,
    title: "Reddit other tenant note",
    body: "spec",
    visibility: "team",
  });

  const hits = await searchNotesAcrossProjects(ctx1, "reddit");
  expect(hits.map((h) => h.title)).toEqual(["Reddit shadowban checker"]);
  expect(hits[0].projectId).toBe(f1.projectId);
  expect(hits[0].noteRef).toMatch(/-N\d+$/);
});

test("excludes another member's private note", async () => {
  const f = await seedUserOrgProject("xnote3");
  const owner = makeAuthContext(f.userId);
  const otherId = await seedSecondMember(f.organizationId, "xnote3b");
  const other = makeAuthContext(otherId);

  await createNote(owner, {
    projectId: f.projectId,
    title: "Pelican team note",
    body: "shared",
    visibility: "team",
  });
  await createNote(other, {
    projectId: f.projectId,
    title: "Pelican private draft",
    body: "secret",
    visibility: "private",
  });

  const ownerHits = await searchNotesAcrossProjects(owner, "pelican");
  expect(ownerHits.map((h) => h.title)).toEqual(["Pelican team note"]);

  const otherHits = await searchNotesAcrossProjects(other, "pelican");
  expect(otherHits.map((h) => h.title).sort()).toEqual([
    "Pelican private draft",
    "Pelican team note",
  ]);
});

test("resolves a typed note ref case-insensitively", async () => {
  const f = await seedUserOrgProject("XREFA");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "Palette note",
    body: "body",
    visibility: "team",
  });
  const ref = `${note.projectIdentifier}-N${note.sequenceNumber}`;

  const upper = await searchNotesAcrossProjects(ctx, ref);
  expect(upper.map((h) => h.id)).toEqual([note.id]);
  expect(upper[0].noteRef).toBe(ref);

  const lower = await searchNotesAcrossProjects(ctx, ref.toLowerCase());
  expect(lower.map((h) => h.id)).toEqual([note.id]);
});

test("returns empty for a nonexistent or out-of-range note ref", async () => {
  const f = await seedUserOrgProject("XREFB");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "Only note",
    body: "body",
    visibility: "team",
  });

  const bogus = `${note.projectIdentifier}-N9999`;
  expect(await searchNotesAcrossProjects(ctx, bogus)).toEqual([]);

  const outOfRange = `${note.projectIdentifier}-N9999999999`;
  expect(await searchNotesAcrossProjects(ctx, outOfRange)).toEqual([]);
});

test("never resolves another tenant's note ref", async () => {
  const f1 = await seedUserOrgProject("XREFC");
  const f2 = await seedUserOrgProject("XREFD");
  const ctx1 = makeAuthContext(f1.userId);
  const ctx2 = makeAuthContext(f2.userId);

  const foreign = await createNote(ctx2, {
    projectId: f2.projectId,
    title: "Foreign note",
    body: "body",
    visibility: "team",
  });
  const foreignRef = `${foreign.projectIdentifier}-N${foreign.sequenceNumber}`;

  expect(await searchNotesAcrossProjects(ctx1, foreignRef)).toEqual([]);
  expect(
    (await searchNotesAcrossProjects(ctx2, foreignRef)).map((h) => h.id),
  ).toEqual([foreign.id]);
});

test("a ref that resolves nothing falls back to the token match", async () => {
  const f = await seedUserOrgProject("XREFF");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "RFC-N1 rollout",
    body: "body",
    visibility: "team",
  });

  const hits = await searchNotesAcrossProjects(ctx, "RFC-N1");
  expect(hits.map((h) => h.id)).toEqual([note.id]);
});

test("a ref colliding across two of the caller's orgs hits once per org", async () => {
  const f = await seedUserOrgProject("XREFG");
  const ctx = makeAuthContext(f.userId);
  const here = await createNote(ctx, {
    projectId: f.projectId,
    title: "Here",
    body: "body",
    visibility: "team",
  });
  const twin = await seedOrgReusingIdentifier(
    f.userId,
    "xrefg2",
    here.projectIdentifier,
  );
  const there = await createNote(ctx, {
    projectId: twin.projectId,
    title: "There",
    body: "body",
    visibility: "team",
  });

  const hits = await searchNotesAcrossProjects(
    ctx,
    `${here.projectIdentifier}-N${here.sequenceNumber}`,
  );
  expect(hits.map((h) => h.id).sort()).toEqual([here.id, there.id].sort());
  expect(new Set(hits.map((h) => h.organizationId)).size).toBe(2);
});

test("the palette resolves a note by the sequence half of its ref", async () => {
  const f = await seedUserOrgProject("XSEQ");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "Preemption, the tick, and preemption points",
    body: "x",
    visibility: "team",
  });

  const bare = await searchNotesAcrossProjects(
    ctx,
    String(note.sequenceNumber),
  );
  expect(bare.map((h) => h.id)).toContain(note.id);

  const withN = await searchNotesAcrossProjects(ctx, `N${note.sequenceNumber}`);
  expect(withN.map((h) => h.id)).toContain(note.id);
});

test("the palette matches note tags and summary per token", async () => {
  const f = await seedUserOrgProject("XTAG");
  const ctx = makeAuthContext(f.userId);
  const tagged = await createNote(ctx, {
    projectId: f.projectId,
    title: "Deploy runbook",
    body: "content",
  });
  await updateNote(ctx, tagged.id, { tags: ["infra"] });
  const summarized = await createNote(ctx, {
    projectId: f.projectId,
    title: "Q3",
    body: "content",
  });
  await updateNote(ctx, summarized.id, { summary: "billing overhaul plan" });
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Unrelated",
    body: "content",
  });

  const byTag = await searchNotesAcrossProjects(ctx, "infra");
  expect(byTag.map((h) => h.id)).toEqual([tagged.id]);

  const bySummary = await searchNotesAcrossProjects(ctx, "billing");
  expect(bySummary.map((h) => h.id)).toEqual([summarized.id]);
});

test("keeps non-ref token search intact", async () => {
  const f = await seedUserOrgProject("XREFE");
  const ctx = makeAuthContext(f.userId);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Design system spec",
    body: "x",
    visibility: "team",
  });

  const hits = await searchNotesAcrossProjects(ctx, "design");
  expect(hits.map((h) => h.title)).toEqual(["Design system spec"]);
});

test("ranks exact title over substring and validates query length", async () => {
  const f = await seedUserOrgProject("xnote4");
  const ctx = makeAuthContext(f.userId);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "design",
    body: "x",
    visibility: "team",
  });
  await createNote(ctx, {
    projectId: f.projectId,
    title: "design system spec",
    body: "x",
    visibility: "team",
  });

  const hits = await searchNotesAcrossProjects(ctx, "design");
  expect(hits.map((h) => h.title)).toEqual(["design", "design system spec"]);

  expect(await searchNotesAcrossProjects(ctx, "   ")).toEqual([]);
  await expect(
    searchNotesAcrossProjects(ctx, "x".repeat(300)),
  ).rejects.toBeInstanceOf(NoteValidationError);
});

test("the palette treats LIKE metacharacters as literal text", async () => {
  const f = await seedUserOrgProject("XLIKE");
  const ctx = makeAuthContext(f.userId);
  const percent = await createNote(ctx, {
    projectId: f.projectId,
    title: "Rollout at 50% complete",
    body: "x",
    visibility: "team",
  });
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Rollout at 500 complete",
    body: "x",
    visibility: "team",
  });
  const underscore = await createNote(ctx, {
    projectId: f.projectId,
    title: "snake_case naming guide",
    body: "x",
    visibility: "team",
  });
  await createNote(ctx, {
    projectId: f.projectId,
    title: "snakeXcase naming guide",
    body: "x",
    visibility: "team",
  });

  const byPercent = await searchNotesAcrossProjects(ctx, "50%");
  expect(byPercent.map((h) => h.id)).toEqual([percent.id]);

  const byUnderscore = await searchNotesAcrossProjects(ctx, "snake_case");
  expect(byUnderscore.map((h) => h.id)).toEqual([underscore.id]);
});
