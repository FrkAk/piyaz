import "server-only";

/**
 * Shape of the postgres-js driver error after `DrizzleQueryError` wrapping.
 * Only the fields call sites actually consume are listed — keep narrow to
 * avoid leaking driver internals into the type surface.
 */
type DriverError = {
  code?: string;
  constraint_name?: string;
};

/**
 * Maximum cause-chain depth to walk. Two hops covers the documented
 * Drizzle path (driver error → `DrizzleQueryError`); the extra slack
 * absorbs an interleaved framework rewrap. Capped to defeat a
 * pathological self-referential cause cycle.
 */
const MAX_CAUSE_DEPTH = 4;

/**
 * Walk the `.cause` chain to find the underlying driver error that carries
 * a SQLSTATE `code`. Drizzle 0.44+ wraps every driver throw in
 * `DrizzleQueryError`, which puts the postgres-js error (with `code`,
 * `constraint_name`, etc.) on `.cause`. Naïve `err.code === '23505'`
 * checks miss it and fall through to the catch-all error path.
 *
 * @param e - Caught error value.
 * @returns The first object in the chain that carries a string `code`, or
 *   undefined when no driver error is reachable.
 */
export function unwrapDriverError(e: unknown): DriverError | undefined {
  let current: unknown = e;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === null || typeof current !== "object") return undefined;
    const candidate = current as DriverError & { cause?: unknown };
    if (typeof candidate.code === "string") return candidate;
    current = candidate.cause;
  }
  return undefined;
}

/**
 * True when the caught error (or any wrapped cause) is a postgres
 * unique-constraint violation. Centralized so call sites do not duplicate
 * the cause-chain walk.
 *
 * @param e - Caught error value.
 * @returns True iff a driver error with SQLSTATE 23505 is reachable.
 */
export function isUniqueViolation(e: unknown): boolean {
  return unwrapDriverError(e)?.code === "23505";
}
