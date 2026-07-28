import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/lib/auth";
import { applyIssAdvertisementCompat } from "@/lib/auth/oauth-metadata-compat";

const authServerMetadata = oauthProviderAuthServerMetadata(auth);

/**
 * RFC 8414 OAuth Authorization Server Metadata.
 * MCP clients discover this at {origin}/.well-known/oauth-authorization-server.
 * @param request - Incoming GET request.
 * @returns Authorization server metadata JSON.
 */
export async function GET(request: Request): Promise<Response> {
  return applyIssAdvertisementCompat(
    request,
    await authServerMetadata(request),
  );
}
