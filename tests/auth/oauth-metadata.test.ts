import { test, expect } from "bun:test";
import { GET as authServerMetadata } from "@/app/.well-known/oauth-authorization-server/route";
import { GET as protectedResourceMetadata } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as pathAwareResourceMetadata } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";

/**
 * Regression guard for #108 (MYMR-225). MCP clients only add
 * `offline_access` to their authorize request — and therefore only
 * receive a refresh token — when the authorization-server metadata
 * advertises it in `scopes_supported` (MCP authorization spec, Refresh
 * Tokens; SEP-2207). The protected-resource metadata must NOT advertise
 * it, per the same spec.
 *
 * `tests/setup/preload.ts` sets `BETTER_AUTH_URL`, so the module-level
 * `origin` constants in both routes resolve before this file loads them.
 */

test("authorization-server metadata advertises offline_access in scopes_supported", async () => {
  const response = await authServerMetadata(
    new Request("https://example.test/.well-known/oauth-authorization-server"),
  );
  const body = (await response.json()) as { scopes_supported?: string[] };

  expect(body.scopes_supported).toEqual(
    expect.arrayContaining(["openid", "profile", "email", "offline_access"]),
  );
});

test("protected-resource metadata is populated and does not advertise offline_access", async () => {
  const response = await protectedResourceMetadata();
  expect(response.ok).toBe(true);

  const raw = await response.text();
  const body = JSON.parse(raw) as {
    resource?: string;
    authorization_servers?: string[];
  };

  // Confirm real metadata was returned so the negative assertion below is
  // not vacuously true against an empty or errored body.
  expect(body.resource?.endsWith("/api/mcp")).toBe(true);
  expect(body.authorization_servers?.length ?? 0).toBeGreaterThan(0);
  expect(raw).not.toContain("offline_access");
});

test("protected-resource metadata is also served at the RFC 9728 path-aware location", async () => {
  const response = await pathAwareResourceMetadata();
  expect(response.ok).toBe(true);

  const body = (await response.json()) as { resource?: string };
  expect(body.resource?.endsWith("/api/mcp")).toBe(true);
});
