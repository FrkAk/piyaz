import "server-only";
import { headers } from "next/headers";
import { type NextRequest } from "next/server";
import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth";
import { userHasConsentedTo } from "@/lib/data/oauth-session";
import { getAuthContext } from "@/lib/auth/context";
import { error, ok } from "@/lib/api/response";
import { internalError } from "@/lib/api/error";

/**
 * Public client metadata + first-time signal returned to the consent page.
 * Field names mirror BA's OAuth wire format (snake_case) so the page does
 * not have to remap them.
 */
type ConsentMeta = {
  client_id: string;
  client_name: string;
  client_uri?: string;
  logo_uri?: string;
  tos_uri?: string;
  policy_uri?: string;
  isFirstTime: boolean;
};

/**
 * GET handler — return public metadata for the OAuth client plus an
 * `isFirstTime` flag indicating whether the caller has approved this
 * client before. The consent page uses both to render an identity-aware
 * UI and to warn on never-seen clients.
 *
 * Auth: caller must have a valid session. The route mirrors BA's
 * `/oauth2/public-client` (also session-gated). The first-time check
 * is driven by `oauthConsent` rather than `oauthAccessToken` so that
 * token rotation or expiry never resurfaces a previously-approved
 * client as first-time.
 *
 * @param request - Incoming GET with `?client_id=<id>`.
 * @returns Metadata JSON, 400 on missing param, 401 on no session,
 *   404 when the client is unknown / disabled, 500 on infrastructure
 *   failure (BA / DB unreachable).
 */
export async function GET(request: NextRequest): Promise<Response> {
  const clientId = request.nextUrl.searchParams.get("client_id");
  if (!clientId) return error("client_id is required", 400);

  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return error("Unauthorized", 401);
  }

  try {
    let client;
    try {
      client = await auth.api.getOAuthClientPublic({
        query: { client_id: clientId },
        headers: await headers(),
      });
    } catch (err) {
      if (err instanceof APIError && err.status === "NOT_FOUND") {
        return error("Client not found", 404);
      }
      throw err;
    }

    const previouslyConsented = await userHasConsentedTo(ctx.userId, clientId);

    const meta: ConsentMeta = {
      client_id: client.client_id,
      client_name: client.client_name ?? client.client_id,
      client_uri: client.client_uri,
      logo_uri: client.logo_uri,
      tos_uri: client.tos_uri,
      policy_uri: client.policy_uri,
      isFirstTime: !previouslyConsented,
    };
    return ok(meta);
  } catch (err) {
    return internalError("consent-meta", err);
  }
}
