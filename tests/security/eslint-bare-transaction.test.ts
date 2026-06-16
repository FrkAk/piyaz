import { describe, test, expect } from "bun:test";
import { spawn } from "bun";
import { join } from "node:path";

/**
 * Regression test for the no-restricted-syntax selectors in
 * `eslint.config.mjs`. The bare-transaction / bare-execute guards are the
 * last line of defense against a future commit that accidentally opens a
 * `db.transaction(...)` outside `lib/db/rls.ts`. If an eslint upgrade or
 * an accidental selector edit silently disables them, the lint suite
 * keeps passing — this test catches that case.
 *
 * Strategy: pipe a fixture containing each banned pattern through
 * `eslint --stdin --stdin-filename app/_probe.ts` so the config's
 * file-pattern matchers apply, then parse the JSON report.
 */
describe("eslint no-restricted-syntax — bare db transaction guard", () => {
  test("flags bare db.transaction, serviceRoleDb.transaction, and db.select outside the data layer", async () => {
    const fixture = `// Fixture for ESLint bare-transaction guard test.
declare const db: {
  transaction: (fn: () => void) => Promise<void>;
  select: (...args: unknown[]) => unknown;
};
declare const serviceRoleDb: {
  transaction: (fn: () => void) => Promise<void>;
};
export async function bad() {
  await db.transaction(() => {});            // banned
  await serviceRoleDb.transaction(() => {}); // banned
  db.select();                               // banned (bare verb)
}
`;

    // app/* matches the strict rules block in eslint.config.mjs (and
    // is NOT on the ignores list).
    const proc = spawn({
      cmd: [
        "bun",
        "x",
        "eslint",
        "--stdin",
        "--stdin-filename",
        join(process.cwd(), "app", "_eslint_probe.ts"),
        "--format",
        "json",
      ],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });
    proc.stdin.write(fixture);
    await proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const report = JSON.parse(stdout) as Array<{
      messages: Array<{ ruleId: string | null; message: string }>;
    }>;
    expect(report.length).toBe(1);
    const violations = report[0].messages.filter(
      (m) => m.ruleId === "no-restricted-syntax",
    );
    // 3 banned shapes: db.transaction, serviceRoleDb.transaction,
    // db.select.
    expect(violations.length).toBe(3);
    const messages = violations.map((v) => v.message).join("\n");
    expect(messages).toMatch(/withUserContext/);
    expect(messages).toMatch(/serviceRoleDb\.transaction|BYPASSRLS/);
  }, 30_000);

  test("flags bare .batch() calls and neon-http imports outside lib/db", async () => {
    const fixture = `// Fixture for ESLint bare HTTP-batch guard test.
import { drizzle } from "drizzle-orm/neon-http";
declare const httpDb: {
  batch: (queries: unknown[]) => Promise<unknown[]>;
};
export async function bad() {
  await httpDb.batch([]); // banned (bare HTTP batch transaction)
  void drizzle;
}
`;

    const proc = spawn({
      cmd: [
        "bun",
        "x",
        "eslint",
        "--stdin",
        "--stdin-filename",
        join(process.cwd(), "app", "_eslint_probe.ts"),
        "--format",
        "json",
      ],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });
    proc.stdin.write(fixture);
    await proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const report = JSON.parse(stdout) as Array<{
      messages: Array<{ ruleId: string | null; message: string }>;
    }>;
    expect(report.length).toBe(1);
    const syntaxViolations = report[0].messages.filter(
      (m) => m.ruleId === "no-restricted-syntax",
    );
    expect(syntaxViolations.length).toBe(1);
    expect(syntaxViolations[0].message).toMatch(/withUserContextRead/);
    const importViolations = report[0].messages.filter(
      (m) => m.ruleId === "no-restricted-imports",
    );
    expect(importViolations.some((m) => m.message.includes("neon-http"))).toBe(
      true,
    );
  }, 30_000);
});
