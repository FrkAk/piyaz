/**
 * Pre-deploy guard: reject `bun run deploy:cf` while `wrangler.jsonc` still
 * carries placeholder binding IDs. MYMR-165 provisions the real Cloudflare
 * resources; until that lands, every `deploy:cf` should fail loudly here
 * rather than ship a Worker bound to non-existent KV / D1 / R2 resources.
 *
 * Checked invariants:
 *   - No KV namespace `id` is all zeros.
 *   - No D1 `database_id` is the zero UUID.
 *   - No R2 binding still references the `mymir-placeholder-*` bucket name.
 *   - `BROKER_DO_SECRET` is registered as a Wrangler secret in the target
 *     environment (set via `wrangler secret put`). Cannot be checked from
 *     `wrangler.jsonc` alone, so the script shells out to `wrangler secret list`.
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
const PLACEHOLDER_BUCKET_RE = /^mymir-placeholder-/i;

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
interface WranglerConfig {
  kv_namespaces?: KvBinding[];
  d1_databases?: D1Binding[];
  r2_buckets?: R2Binding[];
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

const failures: string[] = [];

const cfg = await readWranglerConfig();

for (const kv of cfg.kv_namespaces ?? []) {
  if (kv.id === ZERO_KV_ID) {
    failures.push(
      `KV namespace "${kv.binding}" still has placeholder id ${ZERO_KV_ID}. ` +
        `Provision via 'wrangler kv namespace create' then patch wrangler.jsonc.`,
    );
  }
}

for (const d1 of cfg.d1_databases ?? []) {
  if (d1.database_id === ZERO_D1_ID) {
    failures.push(
      `D1 database "${d1.binding}" still has placeholder database_id ${ZERO_D1_ID}. ` +
        `Provision via 'wrangler d1 create ${d1.database_name ?? d1.binding}'.`,
    );
  }
}

for (const r2 of cfg.r2_buckets ?? []) {
  if (PLACEHOLDER_BUCKET_RE.test(r2.bucket_name)) {
    failures.push(
      `R2 binding "${r2.binding}" still references placeholder bucket "${r2.bucket_name}". ` +
        `Provision via 'wrangler r2 bucket create' then patch wrangler.jsonc.`,
    );
  }
}

const proc = Bun.spawnSync({
  cmd: ["bunx", "wrangler", "secret", "list", "--env", "production"],
  stdout: "pipe",
  stderr: "pipe",
});
const secretListStdout = proc.stdout.toString();
if (proc.exitCode !== 0) {
  failures.push(
    `Failed to enumerate Wrangler secrets in 'production' env. ` +
      `stderr: ${proc.stderr.toString().trim() || "(empty)"}`,
  );
} else if (!secretListStdout.includes("BROKER_DO_SECRET")) {
  failures.push(
    `BROKER_DO_SECRET is not registered in the 'production' Wrangler env. ` +
      `Set it via 'wrangler secret put BROKER_DO_SECRET --env production'. ` +
      `Generate a value with 'openssl rand -base64 48'.`,
  );
}

if (failures.length > 0) {
  console.error("\nDeploy aborted — wrangler.jsonc is not production-ready:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error("");
  process.exit(1);
}

console.log("Deploy guard: wrangler.jsonc bindings + secrets look healthy.");
