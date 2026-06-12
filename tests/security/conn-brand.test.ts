import { describe, expect, test } from "bun:test";
import type { Conn, ReadConn } from "@/lib/db/raw";
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

/**
 * Type-level guard for the ReadConn brand (the neon-http batch read
 * handle). ReadConn is deliberately DISJOINT from Conn: an HTTP read
 * handle passed to an interactive-transaction helper would run each
 * awaited query as its own stateless request with NO `app.user_id` GUC,
 * silently returning empty (or wrong-tenant) rows under RLS — so the
 * brands must reject each other in both directions.
 */
describe("ReadConn brand — disjoint from Conn, no write builders", () => {
  test("a Conn does NOT satisfy ReadConn and vice versa", () => {
    function takesReadConn(_c: ReadConn): void {
      // intentionally empty
    }
    function takesConn(_c: Conn): void {
      // intentionally empty
    }
    // @ts-expect-error — Conn (AppUserConn | RlsTx) carries no ReadConn brand.
    const wrongRead = (): void => takesReadConn(null as unknown as Conn);
    // @ts-expect-error — ReadConn carries no Conn brand.
    const wrongConn = (): void => takesConn(null as unknown as ReadConn);
    expect(typeof wrongRead).toBe("function");
    expect(typeof wrongConn).toBe("function");
  });

  test("an arbitrary AppDb-shaped value does NOT satisfy ReadConn", () => {
    function takesReadConn(_c: ReadConn): void {
      // intentionally empty
    }
    // @ts-expect-error — plain AppDb has no brand; ReadConn requires one.
    const wrong = (): void => takesReadConn({} as unknown as AppDb);
    expect(typeof wrong).toBe("function");
  });

  test("ReadConn exposes no write builders", () => {
    const readDb = null as unknown as ReadConn;
    // @ts-expect-error — insert is not on the ReadConn surface.
    const insert = (): void => void readDb.insert;
    // @ts-expect-error — update is not on the ReadConn surface.
    const update = (): void => void readDb.update;
    // @ts-expect-error — delete is not on the ReadConn surface.
    const del = (): void => void readDb.delete;
    // @ts-expect-error — transaction is not on the ReadConn surface.
    const transaction = (): void => void readDb.transaction;
    expect(
      [insert, update, del, transaction].every((f) => typeof f === "function"),
    ).toBe(true);
  });
});

/**
 * Type-level guard for the RawReadRows brand: a raw `execute` batch result
 * must pass through `normalizeExecuteResult` — consuming it as an array
 * works on postgres-js (RowList extends Array) but crashes on neon-http
 * ({ rows } object), so the brand makes direct consumption a compile error.
 */
describe("RawReadRows brand — raw results are not directly consumable", () => {
  test("a RawReadRows value exposes no array or rows surface", () => {
    const raw = null as unknown as import("@/lib/db/raw").RawReadRows;
    // @ts-expect-error — map is not on the RawReadRows surface.
    const mapped = (): void => void raw.map;
    // @ts-expect-error — rows is not on the RawReadRows surface.
    const rows = (): void => void raw.rows;
    expect([mapped, rows].every((f) => typeof f === "function")).toBe(true);
  });
});

// Stub is typed but never invoked — the brand check is purely at the
// type system level. Using `unknown as ...` so the test does not pull
// the real `serviceRoleDb` proxy (which would require a live database
// connection just to evaluate the runtime side of the import).
function serviceRoleDbStub(): import("@/lib/db/raw").ServiceRoleConn {
  return null as unknown as import("@/lib/db/raw").ServiceRoleConn;
}
