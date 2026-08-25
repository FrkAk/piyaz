/** Route coverage for organization workspace archive downloads and imports. */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { nextHeadersMockModule } from "@/tests/setup/next-headers-mock";

mock.module("next/headers", nextHeadersMockModule);

import { auth } from "@/lib/auth";
import { setBackend } from "@/lib/api/rate-limit";
import { MemoryRateLimitBackend } from "@/lib/api/rate-limit-memory";
import * as organizationData from "@/lib/data/organization-portability";
import {
  MAX_ORGANIZATION_ARCHIVE_BYTES,
  ORGANIZATION_ARCHIVE_MEDIA_TYPE,
  OrganizationArchiveError,
  type OrganizationArchive,
} from "@/lib/organization-portability/archive";
import { superuserPool } from "@/tests/setup/global";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { GET as exportGET } from "@/app/api/organization/[organizationId]/export/route";
import { POST as importPOST } from "@/app/api/organization/import/route";

const setSession = (
  globalThis as unknown as {
    __setTestSession: (session: { user: { id: string } } | null) => void;
  }
).__setTestSession;

const NOW = "2026-08-24T12:00:00.000Z";

/**
 * Build a valid empty organization archive.
 *
 * @returns Minimal version-1 archive.
 */
function emptyArchive(): OrganizationArchive {
  return {
    format: "piyaz-organization",
    version: 1,
    exportedAt: NOW,
    organization: { name: "Imported Team", slug: "imported-team" },
    projects: [],
    tasks: [],
    taskEdges: [],
    taskAssignments: [],
    taskAcceptanceCriteria: [],
    taskDecisions: [],
    taskLinks: [],
    activityEvents: [],
    notes: [],
    noteFolders: [],
    noteTaskLinks: [],
    noteFeedTasks: [],
    noteLinks: [],
    noteRevisions: [],
  };
}

/**
 * Build an archive whose duplicate project identifiers collide on
 * projects_org_identifier_unique.
 *
 * @returns Archive that contract validation must reject before any write.
 */
function constraintFailingArchive(): OrganizationArchive {
  const archive = emptyArchive();
  archive.projects = [
    {
      sourceId: crypto.randomUUID(),
      title: "First project",
      identifier: "DUP",
      description: "",
      status: "active",
      categories: [],
      createdAt: NOW,
      updatedAt: NOW,
      metaUpdatedAt: NOW,
    },
    {
      sourceId: crypto.randomUUID(),
      title: "Second project",
      identifier: "DUP",
      description: "",
      status: "active",
      categories: [],
      createdAt: NOW,
      updatedAt: NOW,
      metaUpdatedAt: NOW,
    },
  ];
  return archive;
}

/**
 * Build a raw archive import request.
 *
 * @param body - Request body value or raw body source.
 * @param headers - Header overrides.
 * @returns POST request for the import route.
 */
function importRequest(
  body: OrganizationArchive | string | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Request {
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: {
      "content-type": ORGANIZATION_ARCHIVE_MEDIA_TYPE,
      "x-piyaz-dpa-accepted": "true",
      ...headers,
    },
    body:
      typeof body === "string" || body instanceof ReadableStream
        ? body
        : JSON.stringify(body),
    duplex: body instanceof ReadableStream ? "half" : undefined,
  };
  return new Request("http://test/api/organization/import", init);
}

/**
 * Create a body stream that crosses the archive limit without allocating the
 * complete body at once.
 *
 * @returns Chunked request body exceeding the byte ceiling.
 */
function oversizedStream(): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent > MAX_ORGANIZATION_ARCHIVE_BYTES) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
}

/**
 * Stub Better Auth organization creation with equivalent database rows.
 *
 * @param userId - Importing owner id.
 * @returns Spy controlling organization creation.
 */
function stubOrganizationCreation(userId: string) {
  const implementation = async (input: {
    body: { name: string; slug: string };
  }) => {
    const { body } = input;
    const sql = superuserPool();
    const [organization] = await sql<{ id: string }[]>`
        INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
        VALUES (${body.name}, ${body.slug}, now())
        RETURNING id
      `;
    await sql`
        INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
        VALUES (${organization.id}, ${userId}, 'owner', now())
      `;
    return {
      id: organization.id,
      name: body.name,
      slug: body.slug,
      createdAt: new Date(),
      metadata: null,
    };
  };
  return spyOn(auth.api, "createOrganization").mockImplementation(
    implementation as unknown as typeof auth.api.createOrganization,
  );
}

/**
 * Stub Better Auth organization deletion with an equivalent database delete.
 *
 * @returns Spy controlling compensating deletion.
 */
function stubOrganizationDeletion() {
  const implementation = async (input: {
    body: { organizationId: string };
  }) => {
    const { body } = input;
    await superuserPool()`
        DELETE FROM piyaz_auth."organization" WHERE id = ${body.organizationId}
      `;
    return null;
  };
  return spyOn(auth.api, "deleteOrganization").mockImplementation(
    implementation as unknown as typeof auth.api.deleteOrganization,
  );
}

afterEach(async () => {
  mock.restore();
  setBackend("actions", new MemoryRateLimitBackend(60_000));
  await truncateAll();
});

describe("GET /api/organization/[organizationId]/export", () => {
  test("returns 401 when unauthenticated", async () => {
    setSession(null);
    const response = await exportGET(
      new Request("http://test/api/organization/missing/export"),
      { params: Promise.resolve({ organizationId: crypto.randomUUID() }) },
    );
    expect(response.status).toBe(401);
  });

  test("returns a downloadable owner archive", async () => {
    const fixture = await seedUserOrgProject("route-export");
    setSession({ user: { id: fixture.userId } });

    const response = await exportGET(
      new Request(
        `http://test/api/organization/${fixture.organizationId}/export`,
      ),
      {
        params: Promise.resolve({
          organizationId: fixture.organizationId,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      ORGANIZATION_ARCHIVE_MEDIA_TYPE,
    );
    expect(response.headers.get("content-disposition")).toContain(
      "piyaz-team-route-export-workspace.json",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const archive = (await response.json()) as OrganizationArchive;
    expect(archive.projects).toHaveLength(1);
  });

  test("enforces one workspace export per user every 30 days", async () => {
    const fixture = await seedUserOrgProject("route-monthly-limit");
    const [otherOrganization] = await superuserPool()<{ id: string }[]>`
      INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
      VALUES ('Other workspace', 'other-monthly-workspace', now())
      RETURNING id
    `;
    await superuserPool()`
      INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
      VALUES (${otherOrganization.id}, ${fixture.userId}, 'owner', now())
    `;
    setSession({ user: { id: fixture.userId } });
    const request = (organizationId: string) =>
      exportGET(
        new Request(`http://test/api/organization/${organizationId}/export`),
        {
          params: Promise.resolve({ organizationId }),
        },
      );

    expect((await request(fixture.organizationId)).status).toBe(200);

    const limited = await request(otherOrganization.id);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      code: "export_limit_reached",
      error: "You can generate one workspace archive every 30 days.",
    });
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(30 * 24 * 60 * 60);

    await superuserPool()`
      UPDATE organization_export_limits
      SET last_started_at = clock_timestamp() - interval '31 days'
      WHERE user_id = ${fixture.userId}
    `;
    expect((await request(otherOrganization.id)).status).toBe(200);
  });

  test.each(["admin", "member"])("returns 403 for a %s", async (role) => {
    const fixture = await seedUserOrgProject(`route-${role}`);
    await superuserPool()`
      UPDATE piyaz_auth."member" SET role = ${role}
      WHERE "organizationId" = ${fixture.organizationId}
        AND "userId" = ${fixture.userId}
    `;
    setSession({ user: { id: fixture.userId } });

    const response = await exportGET(
      new Request("http://test/api/organization/id/export"),
      { params: Promise.resolve({ organizationId: fixture.organizationId }) },
    );
    expect(response.status).toBe(403);
  });

  test("returns 403 for non-members without disclosing existence", async () => {
    const owner = await seedUserOrgProject("route-outsider-owner");
    const target = await seedUserOrgProject("route-outsider-target");
    setSession({ user: { id: owner.userId } });

    const response = await exportGET(
      new Request("http://test/api/organization/id/export"),
      { params: Promise.resolve({ organizationId: target.organizationId }) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "forbidden",
      error: "You don't have permission to export this workspace.",
    });
  });

  test("returns 400 for a malformed organization id", async () => {
    const fixture = await seedUserOrgProject("route-malformed");
    setSession({ user: { id: fixture.userId } });
    const response = await exportGET(
      new Request("http://test/api/organization/not-a-uuid/export"),
      { params: Promise.resolve({ organizationId: "not-a-uuid" }) },
    );
    expect(response.status).toBe(400);
  });

  test("returns 429 when the archive budget is exhausted", async () => {
    const fixture = await seedUserOrgProject("route-limited");
    setSession({ user: { id: fixture.userId } });
    setBackend("actions", {
      check: async () => ({
        allowed: false,
        limit: 5,
        remaining: 0,
        resetIn: 31,
      }),
    });
    const response = await exportGET(
      new Request("http://test/api/organization/id/export"),
      { params: Promise.resolve({ organizationId: fixture.organizationId }) },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("31");
  });

  test("returns 413 when the workspace exceeds archive bounds", async () => {
    const fixture = await seedUserOrgProject("route-too-large");
    setSession({ user: { id: fixture.userId } });
    spyOn(organizationData, "exportOrganizationWorkspace").mockRejectedValue(
      new OrganizationArchiveError(
        `Archive exceeds ${MAX_ORGANIZATION_ARCHIVE_BYTES} bytes`,
        "archive_too_large",
      ),
    );
    const response = await exportGET(
      new Request("http://test/api/organization/id/export"),
      { params: Promise.resolve({ organizationId: fixture.organizationId }) },
    );
    expect(response.status).toBe(413);
  });
});

describe("POST /api/organization/import", () => {
  test("returns 401 when unauthenticated", async () => {
    setSession(null);
    expect((await importPOST(importRequest(emptyArchive()))).status).toBe(401);
  });

  test("returns the consent gate before reading the body", async () => {
    const fixture = await seedUserOrgProject("import-stale");
    await superuserPool()`
      DELETE FROM legal_acceptances WHERE user_id = ${fixture.userId}
    `;
    setSession({ user: { id: fixture.userId } });
    const response = await importPOST(importRequest("{"));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("terms_acceptance_required");
  });

  test("returns 415 for any other media type", async () => {
    const fixture = await seedUserOrgProject("import-media");
    setSession({ user: { id: fixture.userId } });
    const response = await importPOST(
      importRequest(emptyArchive(), { "content-type": "application/json" }),
    );
    expect(response.status).toBe(415);
  });

  test.each([undefined, "false"])(
    "returns 400 when DPA acceptance is %s",
    async (accepted) => {
      const fixture = await seedUserOrgProject(`import-dpa-${accepted}`);
      setSession({ user: { id: fixture.userId } });
      const headers = accepted
        ? { "x-piyaz-dpa-accepted": accepted }
        : { "x-piyaz-dpa-accepted": "" };
      const response = await importPOST(importRequest(emptyArchive(), headers));
      expect(response.status).toBe(400);
    },
  );

  test("returns 413 for declared and chunked oversized bodies", async () => {
    const fixture = await seedUserOrgProject("import-oversized");
    setSession({ user: { id: fixture.userId } });
    const declared = await importPOST(
      importRequest("{}", {
        "content-length": String(MAX_ORGANIZATION_ARCHIVE_BYTES + 1),
      }),
    );
    expect(declared.status).toBe(413);

    const chunked = await importPOST(importRequest(oversizedStream()));
    expect(chunked.status).toBe(413);
  });

  test("returns 400 for malformed JSON and unsupported versions", async () => {
    const fixture = await seedUserOrgProject("import-invalid");
    setSession({ user: { id: fixture.userId } });
    expect((await importPOST(importRequest("{"))).status).toBe(400);
    expect(
      (
        await importPOST(
          importRequest(JSON.stringify({ ...emptyArchive(), version: 2 })),
        )
      ).status,
    ).toBe(400);
  });

  test("maps organization-limit and exhausted-slug failures", async () => {
    const fixture = await seedUserOrgProject("import-lifecycle");
    setSession({ user: { id: fixture.userId } });
    const createSpy = spyOn(auth.api, "createOrganization");
    createSpy.mockRejectedValueOnce({
      body: { code: "ORGANIZATION_LIMIT_REACHED" },
    });
    const limited = await importPOST(importRequest(emptyArchive()));
    expect(limited.status).toBe(409);
    expect((await limited.json()).code).toBe("organization_limit_reached");

    createSpy.mockRejectedValue({
      body: { code: "ORGANIZATION_SLUG_ALREADY_TAKEN" },
    });
    const exhausted = await importPOST(importRequest(emptyArchive()));
    expect(exhausted.status).toBe(409);
    expect((await exhausted.json()).code).toBe("slug_taken");
    expect(createSpy).toHaveBeenCalledTimes(6);
  });

  test("creates a new organization and returns 201", async () => {
    const fixture = await seedUserOrgProject("import-success");
    setSession({ user: { id: fixture.userId } });
    stubOrganizationCreation(fixture.userId);

    const response = await importPOST(importRequest(emptyArchive()));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { organizationId: string };
    const [organization] = await superuserPool()<
      {
        name: string;
        slug: string;
      }[]
    >`
      SELECT name, slug FROM piyaz_auth."organization" WHERE id = ${body.organizationId}
    `;
    expect(organization).toEqual({
      name: "Imported Team",
      slug: "imported-team",
    });
  });

  test("rejects constraint-violating archives before creating an organization", async () => {
    const fixture = await seedUserOrgProject("import-precheck");
    setSession({ user: { id: fixture.userId } });
    const createSpy = stubOrganizationCreation(fixture.userId);

    const response = await importPOST(
      importRequest(constraintFailingArchive()),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "invalid_archive",
      error:
        "Invalid workspace archive: projects contains duplicate identifier.",
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("deletes the new organization when workspace restoration fails", async () => {
    const fixture = await seedUserOrgProject("import-cleanup");
    setSession({ user: { id: fixture.userId } });
    stubOrganizationCreation(fixture.userId);
    const deleteSpy = stubOrganizationDeletion();
    spyOn(organizationData, "importOrganizationWorkspace").mockRejectedValue(
      new Error("insert failed"),
    );

    const response = await importPOST(importRequest(emptyArchive()));
    expect(response.status).toBe(500);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    const [row] = await superuserPool()<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM piyaz_auth."organization"
      WHERE name = 'Imported Team'
    `;
    expect(row.count).toBe(0);
  });
});
