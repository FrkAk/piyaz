import { test, expect } from "bun:test";
import { GET as authCatchAllGET } from "@/app/api/auth/[...all]/route";
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
 *
 * Loopback IP range: this file owns `127.0.6.x` via `cf-connecting-ip` for the
 * catch-all cases below, keeping BA's in-memory rate-limit bucket isolated.
 * `cookie-attributes` owns `127.0.0.x`, `rate-limit` `127.0.1.x`,
 * `change-password` `127.0.2.x`, `cache-control` `127.0.3.x`. Do not reuse.
 */

const AUTH_BASE = "https://example.test/api/auth";

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

/**
 * Regression guards for openai/codex#31573. Advertising
 * `authorization_response_iss_parameter_supported` arms an issuer check Codex
 * cannot satisfy, breaking every MCP OAuth login. The compatibility document
 * is gated on `mcp-protocol-version`, so these pin both sides of that gate:
 * MCP clients get the field withheld on every discovery surface, and every
 * other OAuth consumer keeps the fully RFC 9207-compliant document. A
 * dependency bump or a gate regression must fail here, not in users' shells.
 */
const ISS_ADVERTISEMENT = "authorization_response_iss_parameter_supported";
const MCP_CLIENT_HEADERS = { "mcp-protocol-version": "2024-11-05" };

test("authorization-server metadata withholds the iss advertisement from MCP clients", async () => {
  const response = await authServerMetadata(
    new Request("https://example.test/.well-known/oauth-authorization-server", {
      headers: MCP_CLIENT_HEADERS,
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;

  // Confirm real metadata was returned so the negative assertion is not
  // vacuously true against an empty or errored body.
  expect(body.issuer).toBeString();
  expect(body.authorization_endpoint).toBeString();
  expect(body).not.toContainKey(ISS_ADVERTISEMENT);
});

test("authorization-server metadata keeps the iss advertisement for non-MCP clients", async () => {
  const response = await authServerMetadata(
    new Request("https://example.test/.well-known/oauth-authorization-server"),
  );
  const body = (await response.json()) as Record<string, unknown>;

  expect(body.issuer).toBeString();
  expect(body[ISS_ADVERTISEMENT]).toBe(true);
});

test("the MCP compatibility document is uncacheable and varies on the gate header", async () => {
  const response = await authServerMetadata(
    new Request("https://example.test/.well-known/oauth-authorization-server", {
      headers: MCP_CLIENT_HEADERS,
    }),
  );

  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")?.toLowerCase()).toContain(
    "mcp-protocol-version",
  );
});

test("the compliant document stays cacheable and varies on the gate header", async () => {
  const response = await authServerMetadata(
    new Request("https://example.test/.well-known/oauth-authorization-server"),
  );

  expect(response.headers.get("cache-control")).toContain("public");
  expect(response.headers.get("vary")?.toLowerCase()).toContain(
    "mcp-protocol-version",
  );
});

test("basePath oauth-authorization-server applies the same gate", async () => {
  const forMcp = await authCatchAllGET(
    new Request(`${AUTH_BASE}/.well-known/oauth-authorization-server`, {
      method: "GET",
      headers: { ...MCP_CLIENT_HEADERS, "cf-connecting-ip": "127.0.6.10" },
    }),
  );
  const forBrowser = await authCatchAllGET(
    new Request(`${AUTH_BASE}/.well-known/oauth-authorization-server`, {
      method: "GET",
      headers: { "cf-connecting-ip": "127.0.6.11" },
    }),
  );

  expect((await forMcp.json()) as Record<string, unknown>).not.toContainKey(
    ISS_ADVERTISEMENT,
  );
  expect(forMcp.headers.get("cache-control")).toBe("no-store");
  expect(
    ((await forBrowser.json()) as Record<string, unknown>)[ISS_ADVERTISEMENT],
  ).toBe(true);
});

test("basePath openid-configuration applies the same gate", async () => {
  const forMcp = await authCatchAllGET(
    new Request(`${AUTH_BASE}/.well-known/openid-configuration`, {
      method: "GET",
      headers: { ...MCP_CLIENT_HEADERS, "cf-connecting-ip": "127.0.6.12" },
    }),
  );
  const forBrowser = await authCatchAllGET(
    new Request(`${AUTH_BASE}/.well-known/openid-configuration`, {
      method: "GET",
      headers: { "cf-connecting-ip": "127.0.6.13" },
    }),
  );

  expect((await forMcp.json()) as Record<string, unknown>).not.toContainKey(
    ISS_ADVERTISEMENT,
  );
  expect(
    ((await forBrowser.json()) as Record<string, unknown>)[ISS_ADVERTISEMENT],
  ).toBe(true);
});
