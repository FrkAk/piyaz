/**
 * Pre-deploy guard: reject `bun run deploy:cf` while the production
 * configuration in `wrangler.jsonc` is not ready. `deploy:cf` targets
 * `--env production`; all production bindings live under `env.production`
 * so the guard inspects that section (top-level config is reserved for
 * `wrangler dev` and intentionally has no real binding IDs, which makes
 * an accidental `wrangler deploy` without `--env` fail fast instead of
 * misbinding production resources).
 *
 * Checked invariants:
 *   - `env.production` exists.
 *   - No KV namespace `id` in `env.production` is all zeros.
 *   - No D1 `database_id` in `env.production` is the zero UUID.
 *   - No R2 binding in `env.production` references a `piyaz-placeholder-*` bucket.
 *   - Every required production secret is registered in the production
 *     Wrangler env: BROKER_DO_SECRET (broker DO HMAC key), BETTER_AUTH_SECRET
 *     (Better-auth signing key), DATABASE_URL / DATABASE_SERVICE_ROLE_URL /
 *     DATABASE_AUTH_URL (Neon connection strings for the three DB roles).
 *     Cannot be checked from `wrangler.jsonc` alone, so the script shells out
 *     to `wrangler secret list --env production`.
 *
 * Run from the `deploy:cf` script chain. Exits with code 1 on any failure
 * and prints a remediation hint.
 */
import path from "node:path";
import fs from "node:fs/promises";

const ROOT = path.resolve(import.meta.dir, "..");
const WRANGLER_JSONC = path.join(ROOT, "wrangler.jsonc");

const ZERO_KV_ID = "00000000000000000000000000000000";
const ZERO_D1_ID = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_BUCKET_RE = /^piyaz-placeholder-/i;

interface KvBinding {
  binding: string;
  id: string;
}
interface D1Binding {
  binding: string;
  database_id: string;
  database_name?: string;
}
interface R2Binding {
  binding: string;
  bucket_name: string;
}
interface WranglerEnvBindings {
  kv_namespaces?: KvBinding[];
  d1_databases?: D1Binding[];
  r2_buckets?: R2Binding[];
}
interface WranglerConfig extends WranglerEnvBindings {
  env?: { production?: WranglerEnvBindings };
}

/**
 * Strip `// line` and `/* block *\/` comments so the JSONC config parses
 * with the standard `JSON.parse`. Keeps the file diffable without
 * pulling in a dedicated JSONC parser as a dev dependency.
 *
 * @param source - JSONC text.
 * @returns Plain JSON text.
 */
function stripJsonc(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Read and parse `wrangler.jsonc` into a strongly-typed binding view.
 *
 * @returns Parsed wrangler config (only the binding sections we audit).
 * @throws Error when the file cannot be read or parsed.
 */
async function readWranglerConfig(): Promise<WranglerConfig> {
  const raw = await fs.readFile(WRANGLER_JSONC, "utf8");
  return JSON.parse(stripJsonc(raw)) as WranglerConfig;
}

/**
 * Print the accumulated failures and abort with exit code 1.
 *
 * @param failures - Non-empty list of failure messages.
 */
function abortWithFailures(failures: string[]): never {
  console.error("\nDeploy aborted — wrangler.jsonc is not production-ready:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error("");
  process.exit(1);
}

const cfg = await readWranglerConfig();
const prod = cfg.env?.production;
if (!prod) {
  abortWithFailures([
    "No 'env.production' section found in wrangler.jsonc. " +
      "'deploy:cf' targets '--env production' and the production bindings must live under that section.",
  ]);
}

const failures: string[] = [];

for (const kv of prod.kv_namespaces ?? []) {
  if (kv.id === ZERO_KV_ID) {
    failures.push(
      `KV namespace "${kv.binding}" in env.production still has placeholder id ${ZERO_KV_ID}. ` +
        `Provision via 'wrangler kv namespace create' then patch wrangler.jsonc.`,
    );
  }
}

for (const d1 of prod.d1_databases ?? []) {
  if (d1.database_id === ZERO_D1_ID) {
    failures.push(
      `D1 database "${d1.binding}" in env.production still has placeholder database_id ${ZERO_D1_ID}. ` +
        `Provision via 'wrangler d1 create ${d1.database_name ?? d1.binding}'.`,
    );
  }
}

for (const r2 of prod.r2_buckets ?? []) {
  if (PLACEHOLDER_BUCKET_RE.test(r2.bucket_name)) {
    failures.push(
      `R2 binding "${r2.binding}" in env.production still references placeholder bucket "${r2.bucket_name}". ` +
        `Provision via 'wrangler r2 bucket create' then patch wrangler.jsonc.`,
    );
  }
}

const REQUIRED_SECRETS = [
  "BROKER_DO_SECRET",
  "BETTER_AUTH_SECRET",
  "DATABASE_URL",
  "DATABASE_SERVICE_ROLE_URL",
  "DATABASE_AUTH_URL",
] as const;

interface WranglerSecretEntry {
  name: string;
  type: string;
}

/**
 * Resolve the production secret names registered with Wrangler.
 *
 * Parses `wrangler secret list --env production`'s JSON output and returns
 * the exact secret names — substring matching against raw stdout (the
 * previous approach) would treat a future `DATABASE_URL_BACKUP` as
 * satisfying the `DATABASE_URL` check.
 *
 * @returns Set of secret names registered in the production env, or null
 *   when the wrangler invocation failed (with reason appended to the
 *   failure list out-of-band).
 */
function listProductionSecretNames(failures: string[]): Set<string> | null {
  const cmdResult = Bun.spawnSync({
    cmd: ["bunx", "wrangler", "secret", "list", "--env", "production"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (cmdResult.exitCode !== 0) {
    failures.push(
      `Failed to enumerate Wrangler secrets in 'production' env. ` +
        `stderr: ${cmdResult.stderr.toString().trim() || "(empty)"}`,
    );
    return null;
  }
  const stdout = cmdResult.stdout.toString().trim();
  try {
    const parsed = JSON.parse(stdout) as WranglerSecretEntry[];
    return new Set(parsed.map((s) => s.name));
  } catch (err) {
    failures.push(
      `Could not parse 'wrangler secret list' output as JSON. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}. ` +
        `Raw stdout (first 200 chars): ${stdout.slice(0, 200)}`,
    );
    return null;
  }
}

/**
 * Assert the Drizzle migration journal is internally consistent: every entry
 * in `_journal.json` has its `<tag>.sql` migration and `<idx>_snapshot.json`,
 * so `drizzle-kit migrate` cannot fail mid-deploy on a file a partial
 * migration commit left out.
 *
 * @param failures - Accumulator appended with any inconsistency found.
 */
async function assertMigrationJournalConsistent(
  failures: string[],
): Promise<void> {
  const drizzleDir = path.join(ROOT, "drizzle");
  let entries: Array<{ idx: number; tag: string }>;
  try {
    const journal = JSON.parse(
      await fs.readFile(path.join(drizzleDir, "meta", "_journal.json"), "utf8"),
    ) as { entries?: Array<{ idx: number; tag: string }> };
    entries = journal.entries ?? [];
  } catch (err) {
    failures.push(
      `Cannot read the Drizzle migration journal at drizzle/meta/_journal.json: ` +
        `${err instanceof Error ? err.message : String(err)}.`,
    );
    return;
  }
  for (const entry of entries) {
    const idx = String(entry.idx).padStart(4, "0");
    try {
      await fs.access(path.join(drizzleDir, `${entry.tag}.sql`));
    } catch {
      failures.push(
        `Migration journal references a missing SQL file: drizzle/${entry.tag}.sql.`,
      );
    }
    try {
      await fs.access(path.join(drizzleDir, "meta", `${idx}_snapshot.json`));
    } catch {
      failures.push(
        `Migration journal references a missing snapshot: drizzle/meta/${idx}_snapshot.json.`,
      );
    }
  }
}

const presentSecrets = listProductionSecretNames(failures);
if (presentSecrets) {
  for (const name of REQUIRED_SECRETS) {
    if (!presentSecrets.has(name)) {
      failures.push(
        `${name} is not registered in the 'production' Wrangler env. ` +
          `Set it via 'wrangler secret put ${name} --env production'.`,
      );
    }
  }
}

await assertMigrationJournalConsistent(failures);

if (failures.length > 0) {
  abortWithFailures(failures);
}

console.log(
  "Deploy guard: wrangler.jsonc bindings + secrets + migration journal look healthy.",
);
