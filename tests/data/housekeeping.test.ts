import { test, expect, describe, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { captureAppUserError } from "@/tests/setup/expect-query";
import { serviceRoleDb } from "@/lib/db/connection";
import {
  purgeExpiredRows,
  type PurgeResultRow,
} from "@/lib/db/raw/purge-expired-rows";

/** Fixed table order `public.purge_expired_rows` reports in. */
const TABLE_ORDER = [
  "oauthAccessToken",
  "oauthClientAssertion",
  "oauthRefreshToken",
  "session",
  "verification",
  "team_invite_code",
];

/**
 * Index result rows by table name.
 *
 * @param rows - Sweep result rows.
 * @returns Map of table name to row count.
 */
function counts(rows: PurgeResultRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.table_name, r.row_count]));
}

/**
 * Insert a bare user row and return its id.
 *
 * @param sql - Superuser client.
 * @param suffix - Unique suffix for name/email.
 * @returns The new user id.
 */
async function insertUser(
  sql: ReturnType<typeof superuserPool>,
  suffix: string,
): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
    VALUES (${"User " + suffix}, ${"hk-" + suffix + "@test.local"}, true, now())
    RETURNING id
  `;
  return u.id;
}

/**
 * Insert a bare organization row and return its id.
 *
 * @param sql - Superuser client.
 * @param suffix - Unique suffix for name/slug.
 * @returns The new organization id.
 */
async function insertOrg(
  sql: ReturnType<typeof superuserPool>,
  suffix: string,
): Promise<string> {
  const [o] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
    VALUES (${"Org " + suffix}, ${"hk-org-" + suffix}, now())
    RETURNING id
  `;
  return o.id;
}

/**
 * Ensure the housekeeping OAuth client exists for token and consent fixtures.
 *
 * @param sql - Superuser client.
 */
async function ensureOAuthClient(
  sql: ReturnType<typeof superuserPool>,
): Promise<void> {
  await sql`
    INSERT INTO piyaz_auth."oauthClient" ("clientId", "redirectUris")
    VALUES ('hk-client', '{}')
    ON CONFLICT ("clientId") DO NOTHING
  `;
}

/**
 * Insert an oauth access token expiring at `now() + offset`.
 *
 * @param sql - Superuser client.
 * @param expiresOffset - Signed interval, e.g. `-25 hours`.
 * @param revokedOffset - Signed interval for `revoked`, or null.
 * @returns The new row id.
 */
async function insertAccessToken(
  sql: ReturnType<typeof superuserPool>,
  expiresOffset: string,
  revokedOffset: string | null = null,
): Promise<string> {
  await ensureOAuthClient(sql);
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."oauthAccessToken"
      ("token", "clientId", "scopes", "expiresAt", "revoked")
    VALUES ('at-' || gen_random_uuid()::text, 'hk-client', '{}',
            now() + ${expiresOffset}::interval,
            now() + ${revokedOffset}::interval)
    RETURNING id
  `;
  return t.id;
}

/**
 * Insert an OAuth client assertion expiring at `now() + offset`.
 *
 * @param sql - Superuser client.
 * @param expiresOffset - Signed interval for `expiresAt`.
 * @returns The new assertion id.
 */
async function insertClientAssertion(
  sql: ReturnType<typeof superuserPool>,
  expiresOffset: string,
): Promise<string> {
  const [assertion] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."oauthClientAssertion" ("id", "expiresAt")
    VALUES ('assertion-' || gen_random_uuid()::text,
            now() + ${expiresOffset}::interval)
    RETURNING id
  `;
  return assertion.id;
}

/**
 * Insert an oauth refresh token; `revokedOffset` null keeps it unrevoked.
 *
 * @param sql - Superuser client.
 * @param userId - Owning user id.
 * @param expiresOffset - Signed interval for `expiresAt`.
 * @param revokedOffset - Signed interval for `revoked`, or null.
 * @returns The new row id.
 */
async function insertRefreshToken(
  sql: ReturnType<typeof superuserPool>,
  userId: string,
  expiresOffset: string,
  revokedOffset: string | null = null,
): Promise<string> {
  await ensureOAuthClient(sql);
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."oauthRefreshToken"
      ("token", "clientId", "scopes", "userId", "expiresAt", "revoked")
    VALUES ('rt-' || gen_random_uuid()::text, 'hk-client', '{}', ${userId},
            now() + ${expiresOffset}::interval,
            now() + ${revokedOffset}::interval)
    RETURNING id
  `;
  return t.id;
}

/**
 * Insert a session expiring at `now() + offset`.
 *
 * @param sql - Superuser client.
 * @param userId - Owning user id.
 * @param expiresOffset - Signed interval for `expiresAt`.
 * @returns The new row id.
 */
async function insertSession(
  sql: ReturnType<typeof superuserPool>,
  userId: string,
  expiresOffset: string,
): Promise<string> {
  const [s] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."session" ("expiresAt", "token", "updatedAt", "userId")
    VALUES (now() + ${expiresOffset}::interval, 'tok-' || gen_random_uuid()::text, now(), ${userId})
    RETURNING id
  `;
  return s.id;
}

/**
 * Insert a verification row expiring at `now() + offset`.
 *
 * @param sql - Superuser client.
 * @param expiresOffset - Signed interval for `expiresAt`.
 * @returns The new row id.
 */
async function insertVerification(
  sql: ReturnType<typeof superuserPool>,
  expiresOffset: string,
): Promise<string> {
  const [v] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."verification" ("identifier", "value", "expiresAt")
    VALUES ('hk-' || gen_random_uuid()::text, 'v', now() + ${expiresOffset}::interval)
    RETURNING id
  `;
  return v.id;
}

/**
 * Insert a team invite code; null offsets leave the column NULL.
 *
 * @param sql - Superuser client.
 * @param orgId - Owning organization id (one code per org).
 * @param revokedOffset - Signed interval for `revoked_at`, or null.
 * @param expiresOffset - Signed interval for `expires_at`, or null.
 * @returns The new row id.
 */
async function insertInviteCode(
  sql: ReturnType<typeof superuserPool>,
  orgId: string,
  revokedOffset: string | null,
  expiresOffset: string | null,
): Promise<string> {
  const [c] = await sql<{ id: string }[]>`
    INSERT INTO public.team_invite_code (organization_id, code, revoked_at, expires_at)
    VALUES (${orgId}, 'code-' || gen_random_uuid()::text,
            now() + ${revokedOffset}::interval,
            now() + ${expiresOffset}::interval)
    RETURNING id
  `;
  return c.id;
}

/**
 * Collect the surviving ids of a swept table.
 *
 * @param sql - Superuser client.
 * @param table - Schema-qualified quoted table name.
 * @returns Set of remaining row ids.
 */
async function remainingIds(
  sql: ReturnType<typeof superuserPool>,
  table: string,
): Promise<Set<string>> {
  const rows = await sql.unsafe<{ id: string }[]>(`SELECT id FROM ${table}`);
  return new Set(rows.map((r) => r.id));
}

afterEach(async () => {
  await truncateAll();
});

describe("purge_expired_rows boundaries", () => {
  test("oauthAccessToken: deletes revoked or expired rows past the 24h grace", async () => {
    const sql = superuserPool();
    await insertAccessToken(sql, "-25 hours");
    const keep = await insertAccessToken(sql, "-23 hours");
    const live = await insertAccessToken(sql, "30 days");
    await insertAccessToken(sql, "30 days", "-25 hours");
    const keepRevoked = await insertAccessToken(sql, "30 days", "-23 hours");

    const res = await purgeExpiredRows(serviceRoleDb, false, 100);
    expect(counts(res).oauthAccessToken).toBe(2);
    expect(await remainingIds(sql, 'piyaz_auth."oauthAccessToken"')).toEqual(
      new Set([keep, live, keepRevoked]),
    );
  });

  test("oauthClientAssertion: deletes past the 24h grace", async () => {
    const sql = superuserPool();
    await insertClientAssertion(sql, "-25 hours");
    const keep = await insertClientAssertion(sql, "-23 hours");
    const live = await insertClientAssertion(sql, "1 hour");

    const res = await purgeExpiredRows(serviceRoleDb, false, 100);
    expect(counts(res).oauthClientAssertion).toBe(1);
    expect(
      await remainingIds(sql, 'piyaz_auth."oauthClientAssertion"'),
    ).toEqual(new Set([keep, live]));
  });

  test("oauthRefreshToken: revoked OR expired past the 24h grace", async () => {
    const sql = superuserPool();
    const userId = await insertUser(sql, "refresh");
    await insertRefreshToken(sql, userId, "30 days", "-25 hours");
    const keepRevoked = await insertRefreshToken(
      sql,
      userId,
      "30 days",
      "-23 hours",
    );
    await insertRefreshToken(sql, userId, "-25 hours");
    const live = await insertRefreshToken(sql, userId, "30 days");

    const res = await purgeExpiredRows(serviceRoleDb, false, 100);
    expect(counts(res).oauthRefreshToken).toBe(2);
    expect(await remainingIds(sql, 'piyaz_auth."oauthRefreshToken"')).toEqual(
      new Set([keepRevoked, live]),
    );
  });

  test("session: deletes past the 7d grace, keeps within it", async () => {
    const sql = superuserPool();
    const userId = await insertUser(sql, "session");
    await insertSession(sql, userId, "-8 days");
    const keep = await insertSession(sql, userId, "-6 days");
    const live = await insertSession(sql, userId, "7 days");

    const res = await purgeExpiredRows(serviceRoleDb, false, 100);
    expect(counts(res).session).toBe(1);
    expect(await remainingIds(sql, 'piyaz_auth."session"')).toEqual(
      new Set([keep, live]),
    );
  });

  test("verification: deletes past the 7d grace, keeps within it", async () => {
    const sql = superuserPool();
    await insertVerification(sql, "-8 days");
    const keep = await insertVerification(sql, "-6 days");
    const live = await insertVerification(sql, "7 days");

    const res = await purgeExpiredRows(serviceRoleDb, false, 100);
    expect(counts(res).verification).toBe(1);
    expect(await remainingIds(sql, 'piyaz_auth."verification"')).toEqual(
      new Set([keep, live]),
    );
  });

  test("team_invite_code: revoked or expired past the 30d grace", async () => {
    const sql = superuserPool();
    await insertInviteCode(sql, await insertOrg(sql, "ic1"), "-31 days", null);
    const keepRevoked = await insertInviteCode(
      sql,
      await insertOrg(sql, "ic2"),
      "-29 days",
      null,
    );
    await insertInviteCode(sql, await insertOrg(sql, "ic3"), null, "-31 days");
    const active = await insertInviteCode(
      sql,
      await insertOrg(sql, "ic4"),
      null,
      "30 days",
    );

    const res = await purgeExpiredRows(serviceRoleDb, false, 100);
    expect(counts(res).team_invite_code).toBe(2);
    expect(await remainingIds(sql, "public.team_invite_code")).toEqual(
      new Set([keepRevoked, active]),
    );
  });
});

describe("purge_expired_rows modes", () => {
  test("dry run reports would-delete counts and mutates nothing", async () => {
    const sql = superuserPool();
    const at = await insertAccessToken(sql, "-25 hours");
    const assertion = await insertClientAssertion(sql, "-25 hours");
    const userId = await insertUser(sql, "dry");
    const rt = await insertRefreshToken(sql, userId, "-25 hours");
    const s = await insertSession(sql, userId, "-8 days");
    const v = await insertVerification(sql, "-8 days");
    const ic = await insertInviteCode(
      sql,
      await insertOrg(sql, "dry"),
      "-31 days",
      null,
    );

    const res = await purgeExpiredRows(serviceRoleDb, true, 100);
    expect(counts(res)).toEqual({
      oauthAccessToken: 1,
      oauthClientAssertion: 1,
      oauthRefreshToken: 1,
      session: 1,
      verification: 1,
      team_invite_code: 1,
    });
    expect(await remainingIds(sql, 'piyaz_auth."oauthAccessToken"')).toEqual(
      new Set([at]),
    );
    expect(
      await remainingIds(sql, 'piyaz_auth."oauthClientAssertion"'),
    ).toEqual(new Set([assertion]));
    expect(await remainingIds(sql, 'piyaz_auth."oauthRefreshToken"')).toEqual(
      new Set([rt]),
    );
    expect(await remainingIds(sql, 'piyaz_auth."session"')).toEqual(
      new Set([s]),
    );
    expect(await remainingIds(sql, 'piyaz_auth."verification"')).toEqual(
      new Set([v]),
    );
    expect(await remainingIds(sql, "public.team_invite_code")).toEqual(
      new Set([ic]),
    );
  });

  test("batch limit caps each run and leftovers drain on the next", async () => {
    const sql = superuserPool();
    for (let i = 0; i < 5; i++) await insertAccessToken(sql, "-25 hours");

    const dry = await purgeExpiredRows(serviceRoleDb, true, 3);
    expect(counts(dry).oauthAccessToken).toBe(3);
    expect(
      (await remainingIds(sql, 'piyaz_auth."oauthAccessToken"')).size,
    ).toBe(5);

    const first = await purgeExpiredRows(serviceRoleDb, false, 3);
    expect(counts(first).oauthAccessToken).toBe(3);
    expect(
      (await remainingIds(sql, 'piyaz_auth."oauthAccessToken"')).size,
    ).toBe(2);

    const second = await purgeExpiredRows(serviceRoleDb, false, 3);
    expect(counts(second).oauthAccessToken).toBe(2);
    expect(
      (await remainingIds(sql, 'piyaz_auth."oauthAccessToken"')).size,
    ).toBe(0);
  });

  test("returns one zero row per table in fixed order on a clean database", async () => {
    const res = await purgeExpiredRows(serviceRoleDb, false, 10);
    expect(res.map((r) => r.table_name)).toEqual(TABLE_ORDER);
    expect(res.every((r) => r.row_count === 0)).toBe(true);
  });

  test("rejects an out-of-range batch limit", async () => {
    let caught: unknown;
    try {
      await purgeExpiredRows(serviceRoleDb, true, 0);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const cause = (caught as { cause?: unknown }).cause;
    expect(String(cause ?? caught)).toMatch(/out of range/);
  });
});

describe("purge_expired_rows exclusions", () => {
  test("retains legal, activity, consent, and invitation rows regardless of age", async () => {
    const sql = superuserPool();
    const f = await seedUserOrgProject("hk-retained", { legalCurrent: false });
    await ensureOAuthClient(sql);
    const [acceptance] = await sql<{ id: string }[]>`
      INSERT INTO public.legal_acceptances ("user_id", "document_type", "document_version", "accepted_at")
      VALUES (${f.userId}, 'terms', '2020-01-01', now() - interval '400 days')
      RETURNING id
    `;
    const [event] = await sql<{ id: string }[]>`
      INSERT INTO public.activity_events ("project_id", "type", "source", "summary", "created_at")
      VALUES (${f.projectId}, 'task_created', 'web', 'hk seed', now() - interval '400 days')
      RETURNING id
    `;
    const [consent] = await sql<{ id: string }[]>`
      INSERT INTO piyaz_auth."oauthConsent" ("clientId", "userId", "referenceId", "scopes", "createdAt")
      VALUES ('hk-client', ${f.userId}, ${f.organizationId}, '{}', now() - interval '400 days')
      RETURNING id
    `;
    const [invite] = await sql<{ id: string }[]>`
      INSERT INTO piyaz_auth."invitation" ("organizationId", "email", "status", "expiresAt", "inviterId")
      VALUES (${f.organizationId}, 'hk-retained@test.local', 'pending', now() - interval '400 days', ${f.userId})
      RETURNING id
    `;

    await purgeExpiredRows(serviceRoleDb, false, 1000);
    const legal =
      await sql`SELECT id FROM public.legal_acceptances WHERE id = ${acceptance.id}`;
    const activity =
      await sql`SELECT id FROM public.activity_events WHERE id = ${event.id}`;
    const consents =
      await sql`SELECT id FROM piyaz_auth."oauthConsent" WHERE id = ${consent.id}`;
    const invites =
      await sql`SELECT id FROM piyaz_auth."invitation" WHERE id = ${invite.id}`;
    expect(legal.length).toBe(1);
    expect(activity.length).toBe(1);
    expect(consents.length).toBe(1);
    expect(invites.length).toBe(1);
  });

  test("app_user cannot execute the sweep", async () => {
    const f = await seedUserOrgProject("hk-priv", { legalCurrent: false });
    const { code } = await captureAppUserError(f.userId, async (tx) => {
      await tx`SELECT * FROM public.purge_expired_rows(true, 10)`;
    });
    expect(code).toBe("42501");
  });
});
