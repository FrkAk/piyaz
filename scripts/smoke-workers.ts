/**
 * Serve the built OpenNext bundle on local `workerd` and probe the paths whose
 * behavior differs between runtimes.
 *
 * `bun test` runs on undici, which accepts Web API calls the Cloudflare bundle
 * rejects, and neither `typecheck` nor the suite ever loads the bundle. This
 * script closes that gap: it runs the artifact that actually ships, catches
 * runtime errors the type system cannot see, and needs no Cloudflare
 * credentials because `wrangler dev` is local by default.
 *
 * Usage: `bun run build:cf && bun run smoke:cf`.
 */

const PORT = Number(process.env.SMOKE_PORT ?? 8788);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 45_000;
const WORKER_ENTRY = ".open-next/worker.js";

/** Sources whose changes invalidate a previous `build:cf` output. */
const SOURCE_GLOBS = [
  "app/**/*.{ts,tsx}",
  "lib/**/*.{ts,tsx}",
  "components/**/*.{ts,tsx}",
] as const;

/** Single-file sources outside the globbed trees. */
const SOURCE_FILES = [
  "middleware.ts",
  "worker-cf.ts",
  "next.config.ts",
  "open-next.config.ts",
  "wrangler.jsonc",
] as const;

/** One probe against the running worker. */
type Probe = {
  /** Request path. */
  path: string;
  /** Expected HTTP status. */
  status: number;
  /** Request init, defaulting to a plain GET. */
  init?: RequestInit;
  /** Substring the body must contain. */
  bodyIncludes?: string;
  /** What a failure would mean. */
  why: string;
};

const PROBES: Probe[] = [
  {
    path: "/api/auth/.well-known/oauth-authorization-server",
    status: 200,
    bodyIncludes: '"issuer"',
    why: "the Better Auth catch-all rebuilds the request; a bundle-incompatible construction 500s here",
  },
  {
    path: "/.well-known/oauth-protected-resource",
    status: 200,
    why: "control: the worker booted and serves route handlers",
  },
  {
    path: "/sign-in",
    status: 200,
    why: "control: RSC rendering works under workerd",
  },
  {
    path: "/api/mcp",
    status: 401,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    },
    why: "the MCP bearer path boots and rejects an unauthenticated call",
  },
];

/**
 * Newest modification time across the sources a Cloudflare build consumes.
 *
 * @returns Epoch milliseconds of the most recently changed source.
 */
async function newestSourceMtime(): Promise<number> {
  let newest = 0;
  for (const pattern of SOURCE_GLOBS) {
    for await (const path of new Bun.Glob(pattern).scan(".")) {
      const { mtimeMs } = await Bun.file(path).stat();
      if (mtimeMs > newest) newest = mtimeMs;
    }
  }
  for (const path of SOURCE_FILES) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    const { mtimeMs } = await file.stat();
    if (mtimeMs > newest) newest = mtimeMs;
  }
  return newest;
}

/**
 * Fail early when the bundle is missing or older than its sources, so a stale
 * artifact can never report a green smoke.
 *
 * @throws Error when the bundle needs rebuilding.
 */
async function assertFreshBundle(): Promise<void> {
  const worker = Bun.file(WORKER_ENTRY);
  if (!(await worker.exists())) {
    throw new Error(`${WORKER_ENTRY} is missing. Run \`bun run build:cf\`.`);
  }
  const built = (await worker.stat()).mtimeMs;
  if (built < (await newestSourceMtime())) {
    throw new Error(
      `${WORKER_ENTRY} is older than the sources it was built from. Run \`bun run build:cf\`.`,
    );
  }
}

/**
 * Start `wrangler dev` against the built bundle with unreachable database
 * URLs, so the probes exercise the runtime rather than the data layer.
 *
 * @returns The wrangler process and a reader for everything it printed.
 */
function startWorker(): {
  proc: Bun.Subprocess;
  output: () => string;
} {
  const unreachable = "postgres://smoke:smoke@127.0.0.1:1/smoke";
  const proc = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "dev",
      "--env",
      "dev",
      "--local",
      "--test-scheduled",
      "--ip",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--show-interactive-dev-session=false",
      "--var",
      `DATABASE_URL:${unreachable}`,
      "--var",
      `DATABASE_SERVICE_ROLE_URL:${unreachable}`,
      "--var",
      `DATABASE_AUTH_URL:${unreachable}`,
      "--var",
      `BETTER_AUTH_SECRET:${process.env.BETTER_AUTH_SECRET ?? "smoke-not-a-real-secret"}`,
      "--var",
      `BETTER_AUTH_URL:${BASE_URL}`,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );

  const chunks: string[] = [];
  for (const stream of [proc.stdout, proc.stderr]) {
    void (async () => {
      for await (const chunk of stream as ReadableStream<Uint8Array>) {
        chunks.push(new TextDecoder().decode(chunk));
      }
    })();
  }
  return { proc, output: () => chunks.join("") };
}

/**
 * Poll until the worker serves a page, so probe failures mean real defects
 * rather than a cold start.
 *
 * @throws Error when the worker never becomes ready.
 */
async function waitForReady(): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/sign-in`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(400);
  }
  throw new Error(`worker did not serve ${BASE_URL}/sign-in within 45s`);
}

/**
 * Run every probe and report the failures.
 *
 * @returns Human-readable failure lines, empty when all probes passed.
 */
async function runProbes(): Promise<string[]> {
  const failures: string[] = [];
  for (const probe of PROBES) {
    const method = probe.init?.method ?? "GET";
    try {
      const response = await fetch(`${BASE_URL}${probe.path}`, {
        ...probe.init,
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.text();
      if (response.status !== probe.status) {
        failures.push(
          `${method} ${probe.path} returned ${response.status}, expected ${probe.status} (${probe.why})\n    ${body.slice(0, 300)}`,
        );
        continue;
      }
      if (probe.bodyIncludes && !body.includes(probe.bodyIncludes)) {
        failures.push(
          `${method} ${probe.path} body is missing ${probe.bodyIncludes} (${probe.why})`,
        );
        continue;
      }
      console.log(`  ok  ${method} ${probe.path} -> ${response.status}`);
    } catch (error) {
      failures.push(`${method} ${probe.path} failed: ${String(error)}`);
    }
  }
  return failures;
}

/**
 * Whether a log line is the scheduled probe's expected failure event. The
 * smoke DB is unreachable by design, so the handler's own `ok:false`
 * `db_housekeeping` log is the probe's success signal — but only the
 * connection-failure shape. A TypeError inside the handler is the bundle
 * incompatibility this script exists to catch and is never expected.
 *
 * @param line - One worker log line.
 * @returns True when the line is the expected unreachable-DB event.
 */
function isExpectedHousekeepingFailure(line: string): boolean {
  return (
    line.includes('"event":"db_housekeeping"') &&
    line.includes('"ok":false') &&
    !line.includes("TypeError")
  );
}

/**
 * Trigger the scheduled handler through wrangler's scheduled test endpoint
 * and wait for the housekeeping event in the worker log. The DB URLs are
 * unreachable by design, so the expected outcome is the handler's own
 * structured `ok:false` connection-failure log — which proves the handler,
 * the request DB frame, and the raw-builder wiring survive the wrangler
 * bundle without touching a database. A `db_housekeeping` failure carrying
 * a TypeError fails the probe instead of passing it.
 *
 * @param output - Reader over everything the worker printed so far.
 * @returns Human-readable failure lines, empty when the probe passed.
 */
async function probeScheduled(output: () => string): Promise<string[]> {
  const path = "/cdn-cgi/handler/scheduled";
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 200) {
      return [
        `GET ${path} returned ${response.status}, expected 200 (the scheduled handler is not wired into the bundle)`,
      ];
    }
  } catch (error) {
    return [`GET ${path} failed: ${String(error)}`];
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const line = output()
      .split("\n")
      .find(
        (entry) =>
          entry.includes('"event":"db_housekeeping"') &&
          entry.includes('"ok":false'),
      );
    if (line) {
      if (!isExpectedHousekeepingFailure(line)) {
        return [
          `the scheduled handler failed with a TypeError under the wrangler bundle: ${line.trim().slice(0, 300)}`,
        ];
      }
      console.log(`  ok  GET ${path} -> db_housekeeping event logged`);
      return [];
    }
    await Bun.sleep(200);
  }
  return [
    "the scheduled probe never logged a db_housekeeping event (scheduled handler or DB-frame wiring is broken)",
  ];
}

/**
 * Build the bundle's verdict: boot it, probe it, and read its log.
 *
 * @throws Error when the bundle is stale or missing.
 */
async function main(): Promise<void> {
  await assertFreshBundle();
  console.log(`Serving ${WORKER_ENTRY} on ${BASE_URL}`);
  const { proc, output } = startWorker();

  let failures: string[] = [];
  try {
    await waitForReady();
    failures = await runProbes();
    failures.push(...(await probeScheduled(output)));
  } catch (error) {
    failures.push(String(error));
  } finally {
    proc.kill();
    await proc.exited;
  }

  // A probe can pass while the worker logs a runtime error on another path,
  // so the log itself is an assertion. This is what generalizes past the one
  // bug that prompted the script. Only the scheduled probe's expected
  // unreachable-DB db_housekeeping event is exempt; a TypeError inside the
  // handler stays visible to both the probe and this grep.
  const lines = output()
    .split("\n")
    .filter((entry) => !isExpectedHousekeepingFailure(entry));
  for (const marker of ["✘ [ERROR]", "TypeError"]) {
    const line = lines.find((entry) => entry.includes(marker));
    if (!line) continue;
    failures.push(`worker logged ${marker}: ${line.trim().slice(0, 300)}`);
  }

  if (failures.length > 0) {
    console.error("\nWorkers smoke failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\nWorkers smoke passed.");
}

main().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
