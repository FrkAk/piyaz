/**
 * One-time bridge for self-hosted databases created before versioned
 * migrations existed. Such databases were bootstrapped with `db:push`, which
 * force-syncs the schema but never records `drizzle.__drizzle_migrations`, so
 * their migration journal is empty. A plain `db:migrate` would then replay
 * `0000_baseline.sql` against already-existing tables and fail.
 *
 * This script marks the schema baseline as already applied (the same row
 * `drizzle-kit migrate` would have written), so a subsequent `db:migrate`
 * applies only newer migrations. Idempotent: it does nothing once the journal
 * has any entry. Newcomers never need it, since `db:setup` runs `db:migrate`,
 * which seeds the journal at install time.
 *
 * Exits 1 on a missing connection URL, an empty/invalid journal, or a database
 * error.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import postgres from "postgres";

const DRIZZLE_DIR = join(process.cwd(), "drizzle");

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/**
 * Resolve the connection URL for journal writes.
 *
 * @returns The first defined of `DATABASE_SERVICE_ROLE_URL` / `DATABASE_URL`
 *   (`service_role` owns the `drizzle` schema and so can write the journal).
 * @throws Error when no connection URL is set.
 */
function resolveUrl(): string {
  const url = process.env.DATABASE_SERVICE_ROLE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_SERVICE_ROLE_URL (or DATABASE_URL) is required to baseline the migration journal.",
    );
  }
  return url;
}

/**
 * Read the baseline (first) journal entry and compute its migration hash.
 *
 * @returns The baseline entry plus the sha256 hash drizzle-kit stores for it.
 * @throws Error when the journal is empty or malformed.
 */
function readBaseline(): { entry: JournalEntry; hash: string } {
  const journal = JSON.parse(
    readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries?: JournalEntry[] };
  const entry = journal.entries?.[0];
  if (!entry) {
    throw new Error("drizzle/meta/_journal.json has no migration entries.");
  }
  const sql = readFileSync(join(DRIZZLE_DIR, `${entry.tag}.sql`));
  const hash = createHash("sha256").update(sql).digest("hex");
  return { entry, hash };
}

/**
 * Stamp the baseline migration as applied when the journal is empty.
 */
async function main(): Promise<void> {
  const { entry, hash } = readBaseline();
  const sql = postgres(resolveUrl(), { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle");
    await sql.unsafe(
      "CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    );
    const existing = await sql`
      SELECT 1 FROM drizzle.__drizzle_migrations LIMIT 1
    `;
    if (existing.length > 0) {
      console.log(
        "Migration journal already has entries; nothing to baseline.",
      );
      return;
    }
    await sql`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${hash}, ${entry.when})
    `;
    console.log(
      `Marked ${entry.tag} applied. Run \`bun run db:migrate\` to apply newer migrations.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  await main();
} catch (err) {
  console.error(
    `Baseline failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
