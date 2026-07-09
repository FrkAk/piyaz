import { superuserPool } from "./global";

// Listed explicitly so CASCADE doesn't fire NOTICE chatter for the
// FK-dependent children (task_assignees / task_acceptance_criteria /
// task_decisions / task_links). Postgres only emits the
// "truncate cascades to table X" NOTICE when X isn't in the statement.
const TRUNCATE_TABLES = [
  "note_revisions",
  "note_links",
  "note_task_links",
  "note_folders",
  "notes",
  "task_assignees",
  "task_acceptance_criteria",
  "task_decisions",
  "task_links",
  "task_edges",
  "tasks",
  "team_invite_code",
  "projects",
  '"piyaz_auth"."oauthAccessToken"',
  '"piyaz_auth"."oauthRefreshToken"',
  '"piyaz_auth"."oauthConsent"',
  '"piyaz_auth"."oauthClient"',
  '"piyaz_auth"."invitation"',
  '"piyaz_auth"."member"',
  '"piyaz_auth"."session"',
  '"piyaz_auth"."account"',
  '"piyaz_auth"."organization"',
  '"piyaz_auth"."user"',
  '"piyaz_auth"."verification"',
  '"piyaz_auth"."jwks"',
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
