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
  /consentGateResponse|consentRequiredResponse|requireLegalConsent|assertLegalConsent|authorizeWrite/;

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
