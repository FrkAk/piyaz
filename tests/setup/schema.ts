import { superuserPool } from "./global";

// Listed explicitly so CASCADE doesn't fire NOTICE chatter for the
// FK-dependent children (task_assignees / task_acceptance_criteria /
// task_decisions / task_links). Postgres only emits the
// "truncate cascades to table X" NOTICE when X isn't in the statement.
const TRUNCATE_TABLES = [
  "task_assignees",
  "task_acceptance_criteria",
  "task_decisions",
  "task_links",
  "task_edges",
  "tasks",
  "team_invite_code",
  "projects",
  '"neon_auth"."oauthAccessToken"',
  '"neon_auth"."oauthRefreshToken"',
  '"neon_auth"."oauthConsent"',
  '"neon_auth"."oauthClient"',
  '"neon_auth"."invitation"',
  '"neon_auth"."member"',
  '"neon_auth"."session"',
  '"neon_auth"."account"',
  '"neon_auth"."organization"',
  '"neon_auth"."user"',
  '"neon_auth"."verification"',
  '"neon_auth"."jwks"',
];

/**
 * Wipe every test-relevant table. Call between tests to give each one
 * a clean DB without paying the cost of recreating the schema. Runs on
 * the shared superuser pool so no per-call connection setup overhead.
 */
export async function truncateAll(): Promise<void> {
  const sql = superuserPool();
  await sql.unsafe(
    `TRUNCATE ${TRUNCATE_TABLES.join(", ")} RESTART IDENTITY CASCADE`,
  );
}
