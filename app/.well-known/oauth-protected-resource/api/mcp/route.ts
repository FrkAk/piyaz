/**
 * RFC 9728 path-aware Protected Resource Metadata for the `/api/mcp`
 * resource. Per the MCP authorization spec, clients probe this sub-path
 * (`/.well-known/oauth-protected-resource/api/mcp`) before falling back
 * to the root document, so serving it here removes the 404 that breaks
 * resource discovery on token refresh. The metadata is identical to the
 * root handler, which this re-exports.
 */
export { GET } from "@/app/.well-known/oauth-protected-resource/route";
