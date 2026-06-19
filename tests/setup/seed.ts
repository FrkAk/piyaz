import type postgres from "postgres";
import { appUserPool, serviceRolePool, superuserPool } from "./global";

/**
 * Shared pool bound to `app_user` (NOBYPASSRLS). Returned reference is
 * cached process-wide; `.end()` is a no-op so callers don't kill the
 * pool for the next test. Use in RLS-exercising tests to verify
 * policies actually fire.
 *
 * @returns Cached postgres-js client bound to app_user.
 */
export function appUserConnect(): ReturnType<typeof postgres> {
  return appUserPool();
}

/**
 * Shared pool bound to `service_role` (BYPASSRLS). Returned reference is
 * cached process-wide; `.end()` is a no-op. Use only where the prod path
 * also bypasses RLS.
 *
 * @returns Cached postgres-js client bound to service_role.
 */
export function serviceRoleConnect(): ReturnType<typeof postgres> {
  return serviceRolePool();
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
  const sql = superuserPool();
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
    VALUES (${"User " + suffix}, ${"user" + suffix + "@test.local"}, true, now())
    RETURNING id
  `;
  const [o] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
    VALUES (${"Team " + suffix}, ${"team-" + suffix}, now())
    RETURNING id
  `;
  await sql`
    INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
    VALUES (${o.id}, ${u.id}, 'owner', now())
  `;
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO projects ("organization_id", "title", "identifier")
    VALUES (${o.id}, ${"Project " + suffix}, ${"PRJ" + suffix})
    RETURNING id
  `;
  return { userId: u.id, organizationId: o.id, projectId: p.id };
}
