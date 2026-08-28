import { afterEach, describe, expect, test } from "bun:test";
import {
  GET as authGet,
  POST as authPost,
} from "@/app/api/auth/[...all]/route";
import { getMcpResource } from "@/lib/auth/oauth-resource";
import { superuserPool } from "@/tests/setup/global";
import { truncateAll } from "@/tests/setup/schema";

const AUTH_BASE = "https://example.test/api/auth";
const REDIRECT_URI = "https://client.example/callback";
const CURSOR_REDIRECT_URI = "cursor://anysphere.cursor-mcp/oauth/callback";
let registrationAddressSuffix = 10;

interface RegistrationResponse {
  client_id: string;
  client_secret?: string;
  token_endpoint_auth_method?: string;
}

interface RegistrationOptions {
  applicationType?: "native" | "web";
  redirectUri?: string;
  tokenEndpointAuthMethod?: string;
}

/**
 * Register an OAuth authorization-code client through the public DCR route.
 *
 * @param options - Optional registration metadata overrides.
 * @returns The route response and parsed registration body.
 */
async function registerClient(options: RegistrationOptions = {}): Promise<{
  response: Response;
  body: RegistrationResponse;
}> {
  const registration: Record<string, unknown> = {
    client_name: "Better Auth 1.7 test client",
    redirect_uris: [options.redirectUri ?? REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  if (options.tokenEndpointAuthMethod) {
    registration.token_endpoint_auth_method = options.tokenEndpointAuthMethod;
  }
  if (options.applicationType) {
    registration.application_type = options.applicationType;
  }
  const clientAddress = `127.0.8.${registrationAddressSuffix++}`;
  const response = await authPost(
    new Request(`${AUTH_BASE}/oauth2/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": clientAddress,
      },
      body: JSON.stringify(registration),
    }),
  );
  return {
    response,
    body: (await response.json()) as RegistrationResponse,
  };
}

afterEach(async () => {
  await truncateAll();
});

describe("OAuth Provider 1.7 protocol compatibility", () => {
  test("public DCR returns 201 and links the default MCP resource", async () => {
    const { response, body } = await registerClient({
      tokenEndpointAuthMethod: "none",
    });
    expect(response.status).toBe(201);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_secret).toBeUndefined();

    const sql = superuserPool();
    const links = await sql<{ resourceId: string }[]>`
      SELECT "resourceId"
      FROM piyaz_auth."oauthClientResource"
      WHERE "clientId" = ${body.client_id}
    `;
    expect(Array.from(links)).toEqual([{ resourceId: getMcpResource() }]);
  });

  test("omitting the auth method creates a confidential basic client", async () => {
    const { response, body } = await registerClient();
    expect(response.status).toBe(201);
    expect(body.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(body.client_secret).toBeString();
  });

  test("authorize defaults the MCP resource before Better Auth records the grant", async () => {
    const { body } = await registerClient({ tokenEndpointAuthMethod: "none" });
    const url = new URL(`${AUTH_BASE}/oauth2/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", body.client_id);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", "openid offline_access");
    url.searchParams.set("state", "oauth-1-7-state");
    url.searchParams.set("code_challenge", "a".repeat(43));
    url.searchParams.set("code_challenge_method", "S256");

    const response = await authGet(
      new Request(url.toString(), {
        headers: { "cf-connecting-ip": "127.0.8.11" },
      }),
    );
    expect(response.status).toBe(302);
    expect(
      decodeURIComponent(response.headers.get("location") ?? ""),
    ).toContain(`resource=${getMcpResource()}`);
  });

  test("DCR accepts an omitted-type HTTP loopback callback", async () => {
    const { response } = await registerClient({
      redirectUri: "http://127.0.0.1:4567/oauth/callback",
      tokenEndpointAuthMethod: "none",
    });
    expect(response.status).toBe(201);
  });

  test("DCR accepts Cursor's exact callback despite its web type", async () => {
    const { response } = await registerClient({
      applicationType: "web",
      redirectUri: CURSOR_REDIRECT_URI,
      tokenEndpointAuthMethod: "none",
    });
    expect(response.status).toBe(201);
  });

  test("DCR rejects non-HTTP loopback and arbitrary Cursor callbacks", async () => {
    const nonHttpLoopback = await registerClient({
      redirectUri: "ftp://localhost/oauth/callback",
      tokenEndpointAuthMethod: "none",
    });
    expect(nonHttpLoopback.response.status).toBe(400);

    const arbitraryCursor = await registerClient({
      applicationType: "web",
      redirectUri: "cursor://attacker.example/oauth/callback",
      tokenEndpointAuthMethod: "none",
    });
    expect(arbitraryCursor.response.status).toBe(400);
  });
});
