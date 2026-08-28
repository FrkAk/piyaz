import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { getConnectionString, superuserPool } from "@/tests/setup/global";

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

    const [verificationId] = await sql<
      { data_type: string; column_default: string | null }[]
    >`
      SELECT data_type, column_default
      FROM information_schema.columns
      WHERE table_schema = 'piyaz_auth'
        AND table_name = 'verification'
        AND column_name = 'id'
    `;
    expect(verificationId?.data_type).toBe("text");
    expect(verificationId?.column_default).toBe("(gen_random_uuid())::text");

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

test("init-auth upgrades populated verification UUID ids idempotently", async () => {
  const schema = `piyaz_auth_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  const legacyId = crypto.randomUUID();
  const reservationId = "replay_reservation_id_123456789012345678901";
  const initAuth = readFileSync(
    join(process.cwd(), "docker", "init-auth.sql"),
    "utf8",
  ).replaceAll("piyaz_auth", schema);
  const sql = postgres(getConnectionString(), {
    max: 1,
    onnotice: () => undefined,
  });

  try {
    await sql.unsafe(`CREATE SCHEMA "${schema}"`);
    await sql.unsafe(`
      CREATE TABLE "${schema}"."verification" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "identifier" text NOT NULL,
        "value" text NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await sql.unsafe(
      `INSERT INTO "${schema}"."verification"
        ("id", "identifier", "value", "expiresAt")
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [legacyId, "legacy-identifier", "legacy-value"],
    );

    await sql.unsafe(initAuth);
    await sql.unsafe(initAuth);

    const [column] = await sql<
      { data_type: string; column_default: string | null }[]
    >`
      SELECT data_type, column_default
      FROM information_schema.columns
      WHERE table_schema = ${schema}
        AND table_name = 'verification'
        AND column_name = 'id'
    `;
    expect(column?.data_type).toBe("text");
    expect(column?.column_default).toBe("(gen_random_uuid())::text");

    const legacyRows = await sql.unsafe(
      `SELECT "id", "identifier", "value"
       FROM "${schema}"."verification"
       WHERE "id" = $1`,
      [legacyId],
    );
    expect(legacyRows).toHaveLength(1);
    expect(legacyRows[0]?.id).toBe(legacyId);
    expect(legacyRows[0]?.identifier).toBe("legacy-identifier");
    expect(legacyRows[0]?.value).toBe("legacy-value");

    const [primaryKey] = await sql<{ conname: string }[]>`
      SELECT constraint_name AS conname
      FROM information_schema.table_constraints
      WHERE table_schema = ${schema}
        AND table_name = 'verification'
        AND constraint_type = 'PRIMARY KEY'
    `;
    expect(primaryKey?.conname).toBe("verification_pkey");

    const [identifierIndex] = await sql<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = ${schema}
        AND tablename = 'verification'
        AND indexname = 'verification_identifier_idx'
    `;
    expect(identifierIndex?.indexname).toBe("verification_identifier_idx");

    const defaultRows = await sql.unsafe(
      `INSERT INTO "${schema}"."verification"
        ("identifier", "value", "expiresAt")
       VALUES ($1, $2, now() + interval '1 hour')
       RETURNING "id"`,
      ["default-identifier", "default-value"],
    );
    expect(defaultRows[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await sql.unsafe(
      `INSERT INTO "${schema}"."verification"
        ("id", "identifier", "value", "expiresAt")
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [reservationId, "replay-identifier", "replay-value"],
    );
    const [reservation] = await sql.unsafe(
      `SELECT "id" FROM "${schema}"."verification" WHERE "id" = $1`,
      [reservationId],
    );
    expect(reservation?.id).toBe(reservationId);
  } finally {
    await sql.unsafe("RESET search_path");
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await sql.end({ timeout: 5 });
  }
});
