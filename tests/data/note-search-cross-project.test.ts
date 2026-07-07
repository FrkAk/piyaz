import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import {
  createNote,
  searchNotesAcrossProjects,
  NoteValidationError,
} from "@/lib/data/note";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

/**
 * Add a fresh user to an existing org as a plain member.
 *
 * @param organizationId - Org the new member joins.
 * @param suffix - Unique suffix for the user's name/email.
 * @returns The new member's user id.
 */
async function seedSecondMember(
  organizationId: string,
  suffix: string,
): Promise<string> {
  const sql = superuserPool();
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
    VALUES (${"User " + suffix}, ${"user" + suffix + "@test.local"}, true, now())
    RETURNING id
  `;
  await sql`
    INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
    VALUES (${organizationId}, ${u.id}, 'member', now())
  `;
  return u.id;
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
