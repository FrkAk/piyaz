import { describe, expect, test } from "bun:test";
import type { Conn } from "@/lib/db/raw";
import type { AppDb } from "@/lib/db/connection";

/**
 * Type-level regression test for the Conn brand. If a future refactor
 * drops the brand on `AppUserConn` / `RlsTx` / `ServiceRoleConn` (e.g.
 * by simplifying them back to a bare `AppDb` alias), the `@ts-expect-error`
 * markers below stop firing and `tsc --noEmit` fails — surfacing the
 * regression in the typecheck gate, not at runtime via a silent
 * RLS-bypass.
 *
 * Runtime body is a no-op assertion; the contract under test is the
 * TypeScript types themselves.
 */
describe("Conn brand — type-level guard against non-RLS handles", () => {
  test("serviceRoleDb does NOT satisfy Conn", () => {
    function takesConn(_c: Conn): void {
      // intentionally empty
    }
    // @ts-expect-error — serviceRoleDb is ServiceRoleConn, distinct
    // from AppUserConn | RlsTx (the Conn union).
    const wrong = (): void => takesConn(serviceRoleDbStub());
    expect(typeof wrong).toBe("function");
  });

  /**
   * Casts to the un-branded `AppDb` so the test fires on the brand
   * check, not on structural shape — strengthens TC7 from the PR
   * review. A previous version of this test used a hand-rolled
   * `PlainAppDb = { transaction: ... }` stub that failed type-check on
   * the structural shape mismatch; if a future refactor dropped the
   * brand from `AppUserConn`, that test would still fail (for the
   * wrong reason) and the regression would slip through. The real
   * `AppDb` alias matches `AppUserConn`'s structural shape exactly, so
   * the only thing distinguishing them is the brand — exactly what we
   * want the typecheck to enforce.
   */
  test("an arbitrary AppDb-shaped value does NOT satisfy Conn", () => {
    function takesConn(_c: Conn): void {
      // intentionally empty
    }
    // @ts-expect-error — plain AppDb has no brand; Conn requires one.
    const wrong = (): void => takesConn({} as unknown as AppDb);
    expect(typeof wrong).toBe("function");
  });
});

// Stub is typed but never invoked — the brand check is purely at the
// type system level. Using `unknown as ...` so the test does not pull
// the real `serviceRoleDb` proxy (which would require a live database
// connection just to evaluate the runtime side of the import).
function serviceRoleDbStub(): import("@/lib/db/raw").ServiceRoleConn {
  return null as unknown as import("@/lib/db/raw").ServiceRoleConn;
}
