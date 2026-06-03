import { test, expect } from "bun:test";
import { GET as authServerMetadata } from "@/app/.well-known/oauth-authorization-server/route";
import { GET as protectedResourceMetadata } from "@/app/.well-known/oauth-protected-resource/route";

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

test("protected-resource metadata does not advertise offline_access", async () => {
  const response = await protectedResourceMetadata();
  const body = (await response.json()) as { scopes_supported?: string[] };

  expect(body.scopes_supported ?? []).not.toContain("offline_access");
});
