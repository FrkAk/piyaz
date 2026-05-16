import postgres from "postgres";
import { getConnectionString } from "./global";

const TRUNCATE_TABLES = [
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
 * a clean DB without paying the cost of recreating the schema.
 */
export async function truncateAll(): Promise<void> {
  const sql = postgres(getConnectionString(), { max: 1 });
  try {
    await sql.unsafe(
      `TRUNCATE ${TRUNCATE_TABLES.join(", ")} RESTART IDENTITY CASCADE`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
