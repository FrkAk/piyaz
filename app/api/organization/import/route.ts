/** Organization workspace archive import route. */

import { TEAM_ACTION_MESSAGES } from "@/lib/actions/team-errors";
import { checkActionRateLimit } from "@/lib/actions/rate-limit-action";
import { readBodyBounded } from "@/lib/api/read-body-bounded";
import { consentGateResponse } from "@/lib/auth/consent";
import { getAuthContext } from "@/lib/auth/context";
import { importOrganizationWorkspace } from "@/lib/data/organization-portability";
import {
  decodeOrganizationArchive,
  MAX_ORGANIZATION_IMPORT_BYTES,
  MAX_ORGANIZATION_IMPORT_MIB,
  ORGANIZATION_ARCHIVE_MEDIA_TYPE,
  OrganizationArchiveError,
} from "@/lib/organization-portability/archive";
import {
  createImportedOrganization,
  deleteImportedOrganization,
  OrganizationLifecycleError,
} from "@/lib/organization-portability/organization-lifecycle";

const IMPORT_RATE_LIMIT = {
  action: "organization.import",
  windowSeconds: 60,
  perUserMax: 5,
  perIpMax: 10,
} as const;

/**
 * Build a stable JSON error response.
 *
 * @param code - Machine-readable error code.
 * @param message - Client-safe error explanation.
 * @param status - HTTP status code.
 * @param headers - Optional response headers.
 * @returns JSON response.
 */
function jsonError(
  code: string,
  message: string,
  status: number,
  headers?: HeadersInit,
): Response {
  return Response.json(
    { code, error: message },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

/**
 * Map organization creation failures into import-route responses.
 *
 * @param error - Typed lifecycle failure.
 * @returns Client-safe response for expected failures, or null for internal failures.
 */
function lifecycleErrorResponse(
  error: OrganizationLifecycleError,
): Response | null {
  if (
    error.code === "organization_limit_reached" ||
    error.code === "slug_taken"
  ) {
    return jsonError(error.code, TEAM_ACTION_MESSAGES[error.code], 409);
  }
  if (error.code === "dpa_not_accepted" || error.code === "invalid_input") {
    return jsonError(error.code, TEAM_ACTION_MESSAGES[error.code], 400);
  }
  if (error.code === "unauthorized") {
    return jsonError(error.code, TEAM_ACTION_MESSAGES[error.code], 401);
  }
  if (error.code === "forbidden") {
    return jsonError(error.code, TEAM_ACTION_MESSAGES[error.code], 403);
  }
  return null;
}

/**
 * Import a validated archive into a newly created organization.
 *
 * @param request - Raw archive request.
 * @returns New organization id or a client-safe JSON error.
 */
export async function POST(request: Request): Promise<Response> {
  let userId: string;
  try {
    userId = (await getAuthContext()).userId;
  } catch {
    return jsonError("unauthorized", "Unauthorized", 401);
  }

  const consentGate = await consentGateResponse(userId);
  if (consentGate) return consentGate;

  const limit = await checkActionRateLimit(IMPORT_RATE_LIMIT, userId);
  if (!limit.ok) {
    return jsonError(
      "rate_limited",
      "Too many import attempts. Please wait and try again.",
      429,
      { "retry-after": String(limit.retryAfter) },
    );
  }

  // Compare only the media type: a legal parameterized form like
  // `...+json; charset=utf-8` (added by proxies or clients) must pass.
  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== ORGANIZATION_ARCHIVE_MEDIA_TYPE) {
    return jsonError(
      "unsupported_media_type",
      `Content-Type must be ${ORGANIZATION_ARCHIVE_MEDIA_TYPE}.`,
      415,
    );
  }
  if (request.headers.get("x-piyaz-dpa-accepted") !== "true") {
    return jsonError(
      "dpa_not_accepted",
      TEAM_ACTION_MESSAGES.dpa_not_accepted,
      400,
    );
  }

  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_ORGANIZATION_IMPORT_BYTES
  ) {
    return jsonError(
      "archive_too_large",
      `The workspace archive exceeds the ${MAX_ORGANIZATION_IMPORT_MIB} MiB limit.`,
      413,
    );
  }
  const bytes = await readBodyBounded(request, MAX_ORGANIZATION_IMPORT_BYTES);
  if (bytes === null) {
    return jsonError(
      "archive_too_large",
      `The workspace archive exceeds the ${MAX_ORGANIZATION_IMPORT_MIB} MiB limit.`,
      413,
    );
  }

  let archive;
  try {
    archive = decodeOrganizationArchive(bytes);
  } catch (error) {
    if (error instanceof OrganizationArchiveError) {
      if (error.code === "archive_too_large") {
        return jsonError("archive_too_large", error.message, 413);
      }
      return jsonError(
        "invalid_archive",
        `Invalid workspace archive: ${error.message}.`,
        400,
      );
    }
    console.error("[organization-import] archive decode failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return jsonError("internal_error", "Internal error", 500);
  }

  let organization;
  try {
    organization = await createImportedOrganization({
      name: archive.organization.name,
      slug: archive.organization.slug,
      dpaAccepted: true,
      headers: new Headers(request.headers),
    });
  } catch (error) {
    if (error instanceof OrganizationLifecycleError) {
      const response = lifecycleErrorResponse(error);
      if (response) return response;
    }
    console.error("[organization-import] organization creation failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return jsonError("internal_error", "Internal error", 500);
  }

  try {
    await importOrganizationWorkspace(userId, organization.id, archive);
  } catch (restoreError) {
    try {
      await deleteImportedOrganization({
        organizationId: organization.id,
        headers: new Headers(request.headers),
      });
    } catch (cleanupError) {
      console.error("[organization-import] cleanup failed", {
        organizationId: organization.id,
        restoreErrorName:
          restoreError instanceof Error ? restoreError.name : "unknown",
        cleanupErrorName:
          cleanupError instanceof Error ? cleanupError.name : "unknown",
      });
      return jsonError("internal_error", "Internal error", 500);
    }
    console.error("[organization-import] workspace restore failed", {
      organizationId: organization.id,
      errorName: restoreError instanceof Error ? restoreError.name : "unknown",
    });
    return jsonError("internal_error", "Internal error", 500);
  }

  return Response.json(
    { organizationId: organization.id },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}
