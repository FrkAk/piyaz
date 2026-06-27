/**
 * Pre-migrate guard: assert the Drizzle migration journal is internally
 * consistent before `drizzle-kit migrate` runs. The journal must exist, list
 * at least one entry, and every entry must have its `<tag>.sql` migration and
 * `<idx>_snapshot.json`. Runs on every migrate path (dev auto-deploy, prod
 * release, local) so a partial migration commit fails fast here instead of
 * mid-deploy inside drizzle-kit.
 *
 * Exits with code 1 on any inconsistency and prints what is missing.
 */
import path from "node:path";
import fs from "node:fs/promises";

const ROOT = path.resolve(import.meta.dir, "..");
const DRIZZLE_DIR = path.join(ROOT, "drizzle");

interface JournalEntry {
  idx: number;
  tag: string;
}

/**
 * Read and validate the journal's entry list.
 *
 * @returns The non-empty list of journal entries.
 * @throws Error when the journal cannot be read, parsed, or has no entries.
 */
async function readJournalEntries(): Promise<JournalEntry[]> {
  const raw = await fs.readFile(
    path.join(DRIZZLE_DIR, "meta", "_journal.json"),
    "utf8",
  );
  const journal = JSON.parse(raw) as { entries?: JournalEntry[] };
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("drizzle/meta/_journal.json has no migration entries.");
  }
  return journal.entries;
}

/**
 * Append a failure when a journal-referenced file is missing.
 *
 * @param file - Absolute path to the file that must exist.
 * @param label - Human-readable file kind for the failure message.
 * @param failures - Accumulator appended with any missing-file message.
 */
async function assertFileExists(
  file: string,
  label: string,
  failures: string[],
): Promise<void> {
  try {
    await fs.access(file);
  } catch {
    failures.push(
      `Migration journal references a missing ${label}: ${path.relative(ROOT, file)}.`,
    );
  }
}

/**
 * Validate the journal and exit non-zero if anything is missing.
 */
async function main(): Promise<void> {
  let entries: JournalEntry[];
  try {
    entries = await readJournalEntries();
  } catch (err) {
    console.error(
      `Migration journal check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const failures: string[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const idx = String(entry.idx).padStart(4, "0");
      await assertFileExists(
        path.join(DRIZZLE_DIR, `${entry.tag}.sql`),
        "SQL file",
        failures,
      );
      await assertFileExists(
        path.join(DRIZZLE_DIR, "meta", `${idx}_snapshot.json`),
        "snapshot",
        failures,
      );
    }),
  );

  if (failures.length > 0) {
    console.error("Migration journal is inconsistent:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("Migration journal check: all entries have their files.");
}

await main();
