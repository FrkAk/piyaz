/** Owner-only organization workspace archive download route. */

import { checkActionRateLimit } from "@/lib/actions/rate-limit-action";
import { consentGateResponse } from "@/lib/auth/consent";
import { getAuthContext } from "@/lib/auth/context";
import {
  exportOrganizationWorkspace,
  OrganizationExportForbiddenError,
} from "@/lib/data/organization-portability";
import {
  ORGANIZATION_ARCHIVE_MEDIA_TYPE,
  OrganizationArchiveError,
  organizationArchiveFilename,
  serializeOrganizationArchive,
} from "@/lib/organization-portability/archive";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXPORT_RATE_LIMIT = {
  action: "organization.export",
  windowSeconds: 60,
  perUserMax: 5,
  perIpMax: 10,
} as const;

type RouteContext = {
  params: Promise<{ organizationId: string }>;
};

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
 * Download an organization workspace archive when the caller is its owner.
 *
 * @param _request - Incoming request.
 * @param context - Dynamic organization route parameters.
 * @returns Archive attachment or a client-safe JSON error.
 */
export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  let userId: string;
  try {
    userId = (await getAuthContext()).userId;
  } catch {
    return jsonError("unauthorized", "Unauthorized", 401);
  }

  const consentGate = await consentGateResponse(userId);
  if (consentGate) return consentGate;

  const limit = await checkActionRateLimit(EXPORT_RATE_LIMIT, userId);
  if (!limit.ok) {
    return jsonError(
      "rate_limited",
      "Too many export attempts. Please wait and try again.",
      429,
      { "retry-after": String(limit.retryAfter) },
    );
  }

  const { organizationId } = await context.params;
  if (!UUID_RE.test(organizationId)) {
    return jsonError("invalid_input", "Invalid organization id.", 400);
  }

  try {
    const archive = await exportOrganizationWorkspace(userId, organizationId);
    const serialized = serializeOrganizationArchive(archive);
    return new Response(serialized, {
      status: 200,
      headers: {
        "content-type": ORGANIZATION_ARCHIVE_MEDIA_TYPE,
        "content-disposition": `attachment; filename="${organizationArchiveFilename(archive.organization.slug)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof OrganizationExportForbiddenError) {
      return jsonError(
        "forbidden",
        "You don't have permission to export this workspace.",
        403,
      );
    }
    if (
      error instanceof OrganizationArchiveError &&
      error.message.startsWith("Archive exceeds ")
    ) {
      return jsonError(
        "archive_too_large",
        "This workspace exceeds the portable archive limit.",
        413,
      );
    }
    console.error("[organization-export] failed", {
      organizationId,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return jsonError("internal_error", "Internal error", 500);
  }
}
