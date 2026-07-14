/**
 * Mark every pre-existing user as email-verified before enabling the cloud
 * verification gate (`REQUIRE_EMAIL_VERIFICATION`). Accounts created before
 * the gate never received a verification email; flipping the gate without
 * this run would lock every one of them out of sign-in. Idempotent: only
 * rows with `emailVerified = false` are touched, so a rerun reports zero
 * updates. Run against the target head in lockstep with setting the gate
 * var; connects like the RLS scripts, as the migration role via
 * `DATABASE_MIGRATION_URL` (`piyaz_auth` is outside the app roles' grants).
 */
import postgres from "postgres";

/**
 * Read the migration connection string from the environment.
 *
 * @returns The migrator DIRECT connection string.
 * @throws Error when DATABASE_MIGRATION_URL is unset.
 */
function migrationUrl(): string {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    throw new Error(
      "DATABASE_MIGRATION_URL is required to grandfather verified users.",
    );
  }
  return url;
}

/**
 * Flip `emailVerified` to true for every unverified user and report counts.
 *
 * @returns Exit code: 0 on success, 1 on connection or query failure.
 */
async function main(): Promise<number> {
  const sql = postgres(migrationUrl(), { max: 1, onnotice: () => undefined });
  try {
    const [{ total }] = await sql<
      [{ total: string }]
    >`SELECT count(*)::text AS total FROM piyaz_auth."user"`;
    const updated = await sql`
      UPDATE piyaz_auth."user"
      SET "emailVerified" = true, "updatedAt" = now()
      WHERE "emailVerified" = false
      RETURNING id
    `;
    console.log(
      `grandfather-verified-users: ${updated.length} user(s) marked verified, ` +
        `${Number(total) - updated.length} already verified, ${total} total.`,
    );
    return 0;
  } catch (err) {
    console.error("grandfather-verified-users failed:", err);
    return 1;
  } finally {
    await sql.end();
  }
}

process.exit(await main());
