import { afterEach, expect, test } from "bun:test";
import { auth } from "@/lib/auth";
import { legalAcceptances } from "@/lib/db/schema";
import { withUserContext } from "@/lib/db/rls";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";

/**
 * Server-side coverage for the `lib/auth.ts` global `hooks` gates on the
 * organization plugin: the `before` hook blocks every `/organization/*`
 * endpoint for a caller with outstanding personal re-consent, rejects
 * creation unless the DPA is accepted, and the `after` hook persists one
 * `dpa` acceptance row carrying the new organization id, the pinned
 * LEGAL_VERSIONS version, the resolved client IP, and the user-agent.
 *
 * These drive the raw better-auth handler endpoints, which are publicly
 * routed (middleware allowlists `/api/auth/*`) and bypass the server
 * actions, so the hooks are the only line of defense on this path.
 */

afterEach(async () => {
  await truncateAll();
});

/**
 * POST a JSON body to a Better Auth endpoint through the raw handler.
 *
 * @param path - Endpoint path under `/api/auth`.
 * @param body - JSON payload.
 * @param ip - Client IP for the `cf-connecting-ip` header.
 * @param cookie - Session cookie pair for authenticated requests.
 * @param userAgent - Optional user-agent header.
 * @returns The handler response.
 */
function authPost(
  path: string,
  body: unknown,
  ip: string,
  cookie?: string,
  userAgent?: string,
): Promise<Response> {
  return auth.handler(
    new Request(`https://example.test/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        origin: "https://example.test",
        ...(cookie ? { cookie } : {}),
        ...(userAgent ? { "user-agent": userAgent } : {}),
      },
      method: "POST",
    }),
  );
}

/**
 * Extract the `name=value` pair of the session cookie from a response.
 *
 * @param response - BA handler response.
 * @returns Cookie pair for a `Cookie` header, or undefined when absent.
 */
function sessionCookiePair(response: Response): string | undefined {
  const raw = response.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().includes("session_token"));
  return raw?.split(";")[0];
}

/**
 * Sign up a consenting user through the raw endpoint, lifting the session
 * cookie from the sign-up response (better-auth auto-signs-in), so each
 * fixture costs one password hash instead of two.
 *
 * @param email - Account email.
 * @param ip - Loopback IP for the request.
 * @returns User id and session cookie for authenticated follow-ups.
 */
async function signUpWithSession(
  email: string,
  ip: string,
): Promise<{ userId: string; cookie: string }> {
  const password = "real-password-12345";
  const response = await authPost(
    "/sign-up/email",
    { email, name: "Dpa Gate", password, termsAccepted: true },
    ip,
  );
  expect(response.status).toBe(200);
  const cookie = sessionCookiePair(response);
  expect(cookie).toBeDefined();

  const sql = superuserPool();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM piyaz_auth."user" WHERE email = ${email}
  `;
  return { userId: rows[0]!.id, cookie: cookie! };
}

/**
 * Count organizations with the given slug via the superuser pool.
 *
 * @param slug - Organization slug to count.
 * @returns Matching row count.
 */
async function orgCountBySlug(slug: string): Promise<number> {
  const sql = superuserPool();
  const rows = await sql`
    SELECT id FROM piyaz_auth.organization WHERE slug = ${slug}
  `;
  return rows.length;
}

test("organization/create without DPA acceptance is rejected and writes nothing", async () => {
  const { userId, cookie } = await signUpWithSession(
    "dpa-reject@test.local",
    "127.0.3.10",
  );

  const response = await authPost(
    "/organization/create",
    { name: "No Dpa Team", slug: "no-dpa-team" },
    "127.0.3.10",
    cookie,
  );

  expect(response.status).toBeGreaterThanOrEqual(400);
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe("DPA_NOT_ACCEPTED");
  expect(await orgCountBySlug("no-dpa-team")).toBe(0);

  const rows = await withUserContext(userId, async (tx) =>
    tx.select().from(legalAcceptances),
  );
  expect(rows.filter((row) => row.documentType === "dpa").length).toBe(0);
});

test("organization/create with DPA acceptance writes one evidence row for the new org", async () => {
  const ip = "203.0.113.77";
  const userAgent = "PiyazDpaGateTest/1.0";
  const { userId, cookie } = await signUpWithSession(
    "dpa-accept@test.local",
    ip,
  );

  const response = await authPost(
    "/organization/create",
    { name: "Dpa Team", slug: "dpa-team", dpaAccepted: true },
    ip,
    cookie,
    userAgent,
  );

  expect(response.status).toBe(200);
  expect(await orgCountBySlug("dpa-team")).toBe(1);

  const rows = await withUserContext(userId, async (tx) =>
    tx.select().from(legalAcceptances),
  );
  const dpaRows = rows.filter((row) => row.documentType === "dpa");
  expect(dpaRows.length).toBe(1);
  const dpa = dpaRows[0]!;
  expect(dpa.userId).toBe(userId);
  expect(dpa.organizationId).not.toBeNull();
  expect(dpa.documentVersion).toBe(LEGAL_VERSIONS.dpa);
  expect(dpa.ipAddress).toBe(ip);
  expect(dpa.userAgent).toBe(userAgent);
});

test("organization endpoints are blocked while personal re-consent is outstanding", async () => {
  const ip = "127.0.3.11";
  const { userId, cookie } = await signUpWithSession(
    "reconsent-stale@test.local",
    ip,
  );
  const sql = superuserPool();
  await sql`DELETE FROM legal_acceptances WHERE user_id = ${userId}`;

  const createResponse = await authPost(
    "/organization/create",
    { name: "Stale Team", slug: "stale-team", dpaAccepted: true },
    ip,
    cookie,
  );
  expect(createResponse.status).toBe(403);
  const body = (await createResponse.json()) as { code?: string };
  expect(body.code).toBe("TERMS_ACCEPTANCE_REQUIRED");
  expect(await orgCountBySlug("stale-team")).toBe(0);

  const listResponse = await auth.handler(
    new Request("https://example.test/api/auth/organization/list", {
      headers: {
        "cf-connecting-ip": ip,
        origin: "https://example.test",
        cookie,
      },
    }),
  );
  expect(listResponse.status).toBe(403);
});
