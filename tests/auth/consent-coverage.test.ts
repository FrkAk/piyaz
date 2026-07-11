import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Drift protection for the legal re-consent gate, mirroring the RLS
 * coverage test: every consent-bearing entry point must reference the gate
 * or sit on an explicit, justified allowlist. A new API route or server
 * action that forgets the gate fails here instead of shipping ungated.
 * Pure filesystem scan; no DB.
 */

const ROOT = join(import.meta.dir, "..", "..");

/**
 * Recursively collect files under a directory matching a predicate.
 *
 * @param dir - Absolute directory to walk.
 * @param match - Filename predicate.
 * @returns Repo-relative paths, POSIX-separated, sorted.
 */
async function collectFiles(
  dir: string,
  match: (name: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && match(entry.name))
    .map((entry) => join(entry.parentPath, entry.name).slice(ROOT.length + 1))
    .sort();
}

/**
 * Routes that legitimately skip the route-level consent gate. Every entry
 * carries its rationale; adding one is a reviewed decision.
 */
const ROUTE_ALLOWLIST = new Set([
  "app/api/auth/[...all]/route.ts",
  "app/api/auth/oauth2/token/route.ts",
  "app/api/oauth/consent-meta/route.ts",
  "app/api/mcp/route.ts",
]);

/**
 * `"use server"` modules that legitimately skip the consent gate: the
 * interstitial's own actions and exits (legal; profile export/delete are
 * checked per-function below), public surfaces, and pure delegation
 * wrappers whose callees are themselves gated.
 */
const ACTION_ALLOWLIST = new Set([
  "lib/actions/legal.ts",
  "lib/actions/waitlist.ts",
  "app/onboarding/team/actions.ts",
]);

const GATE_PATTERN =
  /consentGateResponse|consentRequiredResponse|requireLegalConsent|assertLegalConsent|authorizeWrite|authorizeConsentedWrite/;

/** A function that establishes caller identity; the trigger for a gate. */
const IDENTITY_PATTERN = /requireSession\(|getAuthContext\(|getSession\(/;

/**
 * Individual `module::function` entry points that resolve identity yet
 * legitimately skip the gate: account exits reachable from the locked
 * interstitial. Whole-module exemptions stay in `ACTION_ALLOWLIST`.
 */
const FUNCTION_ALLOWLIST = new Set([
  "lib/actions/profile.ts::deleteAccountAction",
  "lib/actions/profile.ts::exportAccountDataAction",
]);

/**
 * Yield each async function declaration matching `pattern` with its body
 * sliced to the next match, so a per-function assertion can inspect one
 * entry point at a time.
 *
 * @param source - Module source text.
 * @param pattern - Global regex whose first defined capture group is the name.
 * @returns Function name/body pairs in file order.
 */
function* asyncFunctions(
  source: string,
  pattern: RegExp,
): Generator<{ name: string; body: string }> {
  const spans: Array<{ name: string; start: number }> = [];
  for (const match of source.matchAll(pattern)) {
    const name = match[1] ?? match[2];
    if (name) spans.push({ name, start: match.index });
  }
  for (let i = 0; i < spans.length; i++) {
    const end = i + 1 < spans.length ? spans[i + 1].start : source.length;
    yield { name: spans[i].name, body: source.slice(spans[i].start, end) };
  }
}

/**
 * Exported server-action entry points, in both `export async function foo`
 * and `export const foo = async () =>` forms, so an arrow-style action
 * cannot slip past the per-function identity check.
 */
const EXPORTED_ASYNC =
  /export\s+(?:async\s+function\s+([A-Za-z0-9_]+)|const\s+([A-Za-z0-9_]+)\s*=\s*async\b)/g;

/**
 * Every async function declaration in a route module, exported or not, so a
 * per-method check also inspects shared handlers the HTTP methods delegate to.
 */
const ROUTE_ASYNC = /async\s+function\s+([A-Za-z0-9_]+)/g;

describe("consent gate coverage", () => {
  test("every API route is gated or allowlisted", async () => {
    const routes = await collectFiles(
      join(ROOT, "app", "api"),
      (name) => name === "route.ts",
    );
    expect(routes.length).toBeGreaterThan(0);
    const ungated: string[] = [];
    for (const route of routes) {
      if (ROUTE_ALLOWLIST.has(route)) continue;
      const source = await readFile(join(ROOT, route), "utf8");
      if (!GATE_PATTERN.test(source)) ungated.push(route);
    }
    expect(ungated).toEqual([]);
  });

  test("every identity-resolving route method gates or is allowlisted", async () => {
    const routes = await collectFiles(
      join(ROOT, "app", "api"),
      (name) => name === "route.ts",
    );
    const ungated: string[] = [];
    for (const route of routes) {
      if (ROUTE_ALLOWLIST.has(route)) continue;
      const source = await readFile(join(ROOT, route), "utf8");
      for (const { name, body } of asyncFunctions(source, ROUTE_ASYNC)) {
        if (!IDENTITY_PATTERN.test(body)) continue;
        if (!GATE_PATTERN.test(body)) ungated.push(`${route}::${name}`);
      }
    }
    expect(ungated).toEqual([]);
  });

  test("every server-action module is gated or allowlisted", async () => {
    const files = [
      ...(await collectFiles(join(ROOT, "app"), (name) =>
        /\.tsx?$/.test(name),
      )),
      ...(await collectFiles(join(ROOT, "lib"), (name) =>
        /\.tsx?$/.test(name),
      )),
    ];
    const ungated: string[] = [];
    for (const file of files) {
      if (ACTION_ALLOWLIST.has(file)) continue;
      const source = await readFile(join(ROOT, file), "utf8");
      if (!source.includes('"use server"')) continue;
      if (!GATE_PATTERN.test(source)) ungated.push(file);
    }
    expect(ungated).toEqual([]);
  });

  test("every identity-resolving server action gates or is allowlisted", async () => {
    const files = [
      ...(await collectFiles(join(ROOT, "app"), (name) =>
        /\.tsx?$/.test(name),
      )),
      ...(await collectFiles(join(ROOT, "lib"), (name) =>
        /\.tsx?$/.test(name),
      )),
    ];
    const ungated: string[] = [];
    for (const file of files) {
      if (ACTION_ALLOWLIST.has(file)) continue;
      const source = await readFile(join(ROOT, file), "utf8");
      if (!source.includes('"use server"')) continue;
      for (const { name, body } of asyncFunctions(source, EXPORTED_ASYNC)) {
        if (!IDENTITY_PATTERN.test(body)) continue;
        if (FUNCTION_ALLOWLIST.has(`${file}::${name}`)) continue;
        if (!GATE_PATTERN.test(body)) ungated.push(`${file}::${name}`);
      }
    }
    expect(ungated).toEqual([]);
  });

  test("the interstitial page never gates itself (redirect loop)", async () => {
    const source = await readFile(
      join(ROOT, "app", "legal", "accept", "page.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/requireLegalConsent\s*\(/);
    expect(source).not.toMatch(/consentGateResponse\s*\(/);
  });

  test("the interstitial's exit actions stay ungated (lockout)", async () => {
    const legal = await readFile(
      join(ROOT, "lib", "actions", "legal.ts"),
      "utf8",
    );
    expect(legal).not.toMatch(/requireLegalConsent|assertLegalConsent/);
    const profile = await readFile(
      join(ROOT, "lib", "actions", "profile.ts"),
      "utf8",
    );
    for (const fn of ["deleteAccountAction", "exportAccountDataAction"]) {
      const body = profile.slice(profile.indexOf(`function ${fn}`));
      const nextFn = body.slice(1).search(/export async function /);
      const scope = nextFn === -1 ? body : body.slice(0, nextFn + 1);
      expect(scope).not.toMatch(/requireLegalConsent|assertLegalConsent/);
    }
  });
});
