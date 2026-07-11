import { NextResponse } from "next/server";
import { error } from "@/lib/api/response";

/** Machine-readable code for the consent-gate 403 body. */
export const CONSENT_REQUIRED_CODE = "terms_acceptance_required";

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

/**
 * 403 emitted when the authenticated caller must re-accept updated legal
 * documents before using the product. Deliberately 403 and not 401: the
 * caller IS authenticated, and a 401 would send API clients into a
 * re-authentication loop that cannot resolve a consent gap. The body is
 * machine-actionable: `code` for branching, `outstanding` for the document
 * list, `acceptUrl` for the page a human must visit.
 *
 * @param outstanding - Document types lacking current-version acceptance.
 * @returns 403 JSON response with the consent-gate contract body.
 */
export function consentRequiredResponse(
  outstanding: readonly string[],
): NextResponse {
  return NextResponse.json(
    {
      error:
        "The Piyaz Terms of Service and Privacy Policy were updated and must be re-accepted.",
      code: CONSENT_REQUIRED_CODE,
      outstanding,
      acceptUrl: "/legal/accept",
    },
    { status: 403 },
  );
}
