import { serverClient } from "@/lib/auth/server-client";

import { getAuthBaseUrl, getMcpResource } from "@/lib/auth/oauth-resource";

const baseUrl = getAuthBaseUrl();
const mcpResource = getMcpResource();

/**
 * RFC 9728 Protected Resource Metadata.
 * MCP clients discover this from the WWW-Authenticate header's resource_metadata URL.
 * Points to the authorization server for token acquisition.
 * @param _request - Incoming GET request (unused).
 * @returns Protected resource metadata JSON.
 */
export async function GET() {
  const metadata = await serverClient.getProtectedResourceMetadata({
    resource: mcpResource,
    authorization_servers: [`${baseUrl}/api/auth`],
  });
  return new Response(JSON.stringify(metadata), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=15, stale-while-revalidate=15",
    },
  });
}
