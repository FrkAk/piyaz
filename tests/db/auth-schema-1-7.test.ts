import { expect, test } from "bun:test";
import { superuserPool } from "@/tests/setup/global";

const EXPECTED_COLUMNS = [
  "account.issuer",
  "jwks.alg",
  "jwks.crv",
  "oauthClient.clientDiscoveryId",
  "oauthClient.clientCredentialsScopes",
  "oauthClient.applicationType",
  "oauthClient.backchannelLogoutUri",
  "oauthClient.backchannelLogoutSessionRequired",
  "oauthClient.jwks",
  "oauthClient.jwksUri",
  "oauthClient.dpopBoundAccessTokens",
  "oauthResource.identifier",
  "oauthClientResource.resourceId",
  "oauthClientAssertion.expiresAt",
  "oauthAccessToken.authorizationCodeId",
  "oauthAccessToken.resources",
  "oauthAccessToken.requestedUserInfoClaims",
  "oauthAccessToken.revoked",
  "oauthAccessToken.confirmation",
  "oauthRefreshToken.authorizationCodeId",
  "oauthRefreshToken.resources",
  "oauthRefreshToken.requestedUserInfoClaims",
  "oauthRefreshToken.rotatedAt",
  "oauthRefreshToken.rotationReplayResponse",
  "oauthRefreshToken.rotationReplayExpiresAt",
  "oauthRefreshToken.confirmation",
  "oauthConsent.resources",
  "oauthConsent.requestedUserInfoClaims",
] as const;

const EXPECTED_INDEXES = [
  "account_issuer_accountId_uidx",
  "oauthResource_identifier_uidx",
  "oauthClientResource_clientId_resourceId_uidx",
  "oauthAccessToken_token_uidx",
  "oauthAccessToken_sessionId_idx",
  "oauthAccessToken_authorizationCodeId_idx",
  "oauthAccessToken_refreshId_idx",
  "oauthRefreshToken_token_uidx",
  "oauthRefreshToken_sessionId_idx",
  "oauthRefreshToken_authorizationCodeId_idx",
] as const;

const EXPECTED_FOREIGN_KEYS = {
  oauthAccessToken_clientId_fk: "c",
  oauthAccessToken_sessionId_fk: "n",
  oauthAccessToken_refreshId_fk: "c",
  oauthRefreshToken_clientId_fk: "c",
  oauthRefreshToken_sessionId_fk: "n",
  oauthConsent_clientId_fk: "c",
} as const;

test("piyaz_auth matches the Better Auth 1.7 schema contract", async () => {
  const sql = superuserPool();
  try {
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'piyaz_auth'
    `;
    const columnSet = new Set(
      columns.map((row) => `${row.table_name}.${row.column_name}`),
    );
    for (const expected of EXPECTED_COLUMNS) {
      expect(columnSet.has(expected), `missing column ${expected}`).toBe(true);
    }

    const [verificationId] = await sql<{ data_type: string }[]>`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = 'piyaz_auth'
        AND table_name = 'verification'
        AND column_name = 'id'
    `;
    expect(verificationId?.data_type).toBe("text");

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'piyaz_auth'
    `;
    const indexSet = new Set(indexes.map((row) => row.indexname));
    for (const expected of EXPECTED_INDEXES) {
      expect(indexSet.has(expected), `missing index ${expected}`).toBe(true);
    }

    const foreignKeys = await sql<{ conname: string; confdeltype: string }[]>`
      SELECT c.conname, c.confdeltype
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'piyaz_auth'
        AND c.contype = 'f'
    `;
    const foreignKeyActions = new Map(
      foreignKeys.map((row) => [row.conname, row.confdeltype]),
    );
    for (const [expected, deleteAction] of Object.entries(
      EXPECTED_FOREIGN_KEYS,
    )) {
      expect(
        foreignKeyActions.get(expected),
        `foreign key ${expected} has the wrong delete action`,
      ).toBe(deleteAction);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
});
