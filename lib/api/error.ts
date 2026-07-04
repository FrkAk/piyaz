import { error } from "@/lib/api/response";

/**
 * Whether internal errors should be returned to the client verbatim.
 * Whitelist semantics: verbose ONLY when `NODE_ENV === "development"`
 * (i.e. running `bun run dev` locally). Every other value — production,
 * test, staging, undefined, typos, future Next.js rename — falls through
 * to the generic "Internal error" body. Fail-safe by default: a silent
 * env-var change can never start leaking SQL fragments, bound parameters,
 * or stack traces.
 *
 * Read at call time so tests can mutate `process.env.NODE_ENV` between
 * cases without re-importing the module.
 *
 * @returns True only when `NODE_ENV === "development"`.
 */
export function isVerboseErrors(): boolean {
  return process.env.NODE_ENV === "development";
}

/**
 * Centralized 500 emitter for route handlers. Always logs the error
 * server-side with a route-scoped label so failures are visible in the
 * dev terminal / production logs even when the response body is generic.
 *
 * Outside `NODE_ENV === "development"` the response body is
 * `{ error: "Internal error" }` — intentionally opaque so untrusted
 * callers can't enumerate schema names, SQL structure, or auth ids that
 * show up in driver-level errors. In `bun run dev` the raw `err.message`
 * is forwarded to the client to speed local debugging.
 *
 * @param label - Route-scoped tag (e.g. `"projects"`, `"task-context"`).
 * @param err - The thrown error.
 * @returns 500 JSON response.
 */
export function internalError(label: string, err: unknown): Response {
  console.error(`[${label}] error:`, err);
  const message =
    isVerboseErrors() && err instanceof Error ? err.message : "Internal error";
  return error(message, 500);
}
