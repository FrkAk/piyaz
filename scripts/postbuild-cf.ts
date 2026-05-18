/**
 * Cloudflare post-build glue: add Mymir-specific Durable Object exports
 * to the OpenNext worker entrypoint.
 *
 * OpenNext's CLI generates `.open-next/worker.js` from a fixed template
 * that exports only its own built-in Durable Objects (DOQueueHandler,
 * DOShardedTagCache, BucketCachePurge). The CLI does not expose an
 * extension hook for user-defined DOs that are referenced from
 * `wrangler.jsonc`. This script bundles `lib/realtime/broker-do.ts` and
 * appends the export to `worker.js` so the `MYMIR_BROKER` binding
 * resolves at startup.
 */
import path from "node:path";
import fs from "node:fs/promises";

const ROOT = path.resolve(import.meta.dir, "..");
const OUT = path.join(ROOT, ".open-next");
const WORKER = path.join(OUT, "worker.js");
const DO_DIR = path.join(OUT, ".build", "durable-objects");
const DO_OUT = path.join(DO_DIR, "mymir-broker.js");
const DO_SRC = path.join(ROOT, "lib/realtime/broker-do.ts");

await fs.mkdir(DO_DIR, { recursive: true });

const result = await Bun.build({
  entrypoints: [DO_SRC],
  outdir: DO_DIR,
  naming: "mymir-broker.js",
  format: "esm",
  target: "browser",
  external: ["cloudflare:workers"],
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Failed to bundle MymirBroker Durable Object");
}

const workerSource = await fs.readFile(WORKER, "utf8");
const EXPORT_LINE = `export { MymirBroker } from "./.build/durable-objects/mymir-broker.js";\n`;
if (workerSource.includes('from "./.build/durable-objects/mymir-broker.js"')) {
  console.log("worker.js already exports MymirBroker — skipping patch");
} else {
  await fs.writeFile(WORKER, `${workerSource.trimEnd()}\n${EXPORT_LINE}`);
  console.log("Patched worker.js to export MymirBroker");
}

console.log(`Mymir Durable Object bundled at ${path.relative(ROOT, DO_OUT)}`);
