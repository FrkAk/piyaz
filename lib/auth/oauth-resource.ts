const DEFAULT_BASE_URL = "http://localhost:3000";

/**
 * Resolve the configured Better Auth base URL.
 *
 * @returns The configured base URL, or the local development default.
 */
export function getAuthBaseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? DEFAULT_BASE_URL;
}

/**
 * Resolve the deployment origin used as the legacy OAuth audience.
 *
 * @returns The origin of the configured Better Auth URL.
 */
export function getAuthOrigin(): string {
  return new URL(getAuthBaseUrl()).origin;
}

/**
 * Resolve the canonical MCP protected-resource identifier.
 *
 * @returns The absolute MCP endpoint URL.
 */
export function getMcpResource(): string {
  return `${getAuthOrigin()}/api/mcp`;
}

/**
 * Resolve every OAuth resource accepted during the 1.7 compatibility cutover.
 *
 * @returns The legacy origin audience followed by the canonical MCP resource.
 */
export function getOAuthResourceIdentifiers(): [string, string] {
  return [getAuthOrigin(), getMcpResource()];
}
