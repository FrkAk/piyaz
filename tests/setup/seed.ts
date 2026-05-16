import postgres from "postgres";
import { getConnectionString } from "./global";

/**
 * Open a postgres connection as `app_user` — the non-BYPASSRLS runtime role
 * provisioned by `tests/setup/migrate.ts:provisionRoles`. Use this in
 * RLS-exercising tests to verify policies actually fire; `seedUserOrgProject`
 * still uses the testcontainer superuser to provision fixtures.
 *
 * Caller MUST `.end({ timeout: 5 })` the returned client.
 *
 * @returns A `postgres` client bound to the app_user role.
 */
export function appUserConnect(): ReturnType<typeof postgres> {
  const url = new URL(getConnectionString());
  url.username = "app_user";
  url.password = "app_user";
  return postgres(url.toString(), { max: 1 });
}

/**
 * Open a postgres connection as `service_role` — the BYPASSRLS connection
 * used by the 4 documented bypass call sites. Use this in tests that need
 * to seed `team_invite_code` rows or to verify bypass-path behavior.
 *
 * Caller MUST `.end({ timeout: 5 })` the returned client.
 *
 * @returns A `postgres` client bound to the service_role role.
 */
export function serviceRoleConnect(): ReturnType<typeof postgres> {
  const url = new URL(getConnectionString());
  url.username = "service_role";
  url.password = "service_role";
  return postgres(url.toString(), { max: 1 });
}

/** Created-on-demand test fixture: a user, an org with the user as owner, and one project. */
export type Fixture = {
  userId: string;
  organizationId: string;
  projectId: string;
};

/**
 * Insert a user, an organization, an owner-membership, and a project.
 * Returns the ids — every test that needs "a project I can read" starts here.
 *
 * @param suffix - Suffix added to slug/email so multiple fixtures don't collide.
 * @returns Created ids.
 */
export async function seedUserOrgProject(suffix = "1"): Promise<Fixture> {
  const sql = postgres(getConnectionString(), { max: 1 });
  try {
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO neon_auth."user" ("name", "email", "emailVerified", "updatedAt")
      VALUES (${"User " + suffix}, ${"user" + suffix + "@test.local"}, true, now())
      RETURNING id
    `;
    const [o] = await sql<{ id: string }[]>`
      INSERT INTO neon_auth."organization" ("name", "slug", "createdAt")
      VALUES (${"Team " + suffix}, ${"team-" + suffix}, now())
      RETURNING id
    `;
    await sql`
      INSERT INTO neon_auth."member" ("organizationId", "userId", "role", "createdAt")
      VALUES (${o.id}, ${u.id}, 'owner', now())
    `;
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO projects ("organization_id", "title", "identifier")
      VALUES (${o.id}, ${"Project " + suffix}, ${"PRJ" + suffix})
      RETURNING id
    `;
    return { userId: u.id, organizationId: o.id, projectId: p.id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
