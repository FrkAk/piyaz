-- Self-managed piyaz_auth schema for Postgres (Better Auth tables).
-- The project does not use Neon Auth Managed; this script owns the schema.
-- Idempotent — safe to re-run on existing databases.

CREATE SCHEMA IF NOT EXISTS piyaz_auth;
SET search_path TO piyaz_auth;

CREATE TABLE IF NOT EXISTS "user" (
    "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name"           text NOT NULL,
    "email"          text NOT NULL UNIQUE,
    "emailVerified"  boolean NOT NULL DEFAULT false,
    "image"          text,
    "createdAt"      timestamptz NOT NULL DEFAULT now(),
    "updatedAt"      timestamptz NOT NULL DEFAULT now(),
    "role"           text,
    "banned"         boolean,
    "banReason"      text,
    "banExpires"     timestamptz
);

CREATE TABLE IF NOT EXISTS "session" (
    "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "expiresAt"              timestamptz NOT NULL,
    "token"                  text NOT NULL UNIQUE,
    "createdAt"              timestamptz NOT NULL DEFAULT now(),
    "updatedAt"              timestamptz NOT NULL,
    "ipAddress"              text,
    "userAgent"              text,
    "userId"                 uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "activeOrganizationId"   text,
    "impersonatedBy"         text
);

CREATE TABLE IF NOT EXISTS "account" (
    "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "accountId"               text NOT NULL,
    "issuer"                  text NOT NULL,
    "providerId"              text NOT NULL,
    "userId"                  uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "accessToken"             text,
    "refreshToken"            text,
    "idToken"                 text,
    "accessTokenExpiresAt"    timestamptz,
    "refreshTokenExpiresAt"   timestamptz,
    "scope"                   text,
    "password"                text,
    "createdAt"               timestamptz NOT NULL DEFAULT now(),
    "updatedAt"               timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
    "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "identifier"   text NOT NULL,
    "value"        text NOT NULL,
    "expiresAt"    timestamptz NOT NULL,
    "createdAt"    timestamptz NOT NULL DEFAULT now(),
    "updatedAt"    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "organization" (
    "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name"        text NOT NULL,
    "slug"        text NOT NULL UNIQUE,
    "logo"        text,
    "createdAt"   timestamptz NOT NULL,
    "metadata"    text
);

CREATE TABLE IF NOT EXISTS "member" (
    "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "organizationId"  uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
    "userId"          uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "role"            text NOT NULL DEFAULT 'member',
    "createdAt"       timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "invitation" (
    "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "organizationId"  uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
    "email"           text NOT NULL,
    "role"            text,
    "status"          text NOT NULL DEFAULT 'pending',
    "expiresAt"       timestamptz NOT NULL,
    "createdAt"       timestamptz NOT NULL DEFAULT now(),
    "inviterId"       uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "jwks" (
    "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "publicKey"    text NOT NULL,
    "privateKey"   text NOT NULL,
    "createdAt"    timestamptz NOT NULL,
    "expiresAt"    timestamptz,
    "alg"          text,
    "crv"          text
);

-- Better Auth 1.7 account/JWKS expansion for existing installations.
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text;
ALTER TABLE "jwks" ADD COLUMN IF NOT EXISTS "alg" text;
ALTER TABLE "jwks" ADD COLUMN IF NOT EXISTS "crv" text;

UPDATE "account"
SET "issuer" = 'local:credential',
    "accountId" = "userId"::text
WHERE "providerId" = 'credential'
  AND ("issuer" IS NULL OR "issuer" = 'local:credential');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "account" WHERE "issuer" IS NULL) THEN
    RAISE EXCEPTION 'Better Auth 1.7 migration requires an explicit issuer mapping for non-credential accounts';
  END IF;
END $$;

ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_accountId_uidx" ON "account"("issuer", "accountId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification"("identifier");
CREATE INDEX IF NOT EXISTS "member_organizationId_idx" ON "member"("organizationId");
CREATE INDEX IF NOT EXISTS "member_userId_idx" ON "member"("userId");
-- Composite index for RLS predicate performance: the 3-hop EXISTS joins
-- on `(organizationId, userId)` need a direct lookup, not bitmap-AND.
CREATE INDEX IF NOT EXISTS "member_org_user_idx" ON "member"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "invitation_organizationId_idx" ON "invitation"("organizationId");
CREATE INDEX IF NOT EXISTS "invitation_email_idx" ON "invitation"("email");

-- OAuth 2.1 Provider tables (used by @better-auth/oauth-provider)

CREATE TABLE IF NOT EXISTS "oauthClient" (
    "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "clientId"                  text NOT NULL UNIQUE,
    "clientSecret"              text,
    "clientDiscoveryId"         text,
    "name"                      text,
    "icon"                      text,
    "metadata"                  text,
    "redirectUris"              text[] NOT NULL,
    "postLogoutRedirectUris"    text[],
    "tokenEndpointAuthMethod"   text,
    "grantTypes"                text[],
    "responseTypes"             text[],
    "scopes"                    text[],
    "clientCredentialsScopes"   text[] DEFAULT '{}',
    -- Compatibility columns retained for the 1.6 -> 1.7 expand/contract rollout.
    "type"                      text,
    "public"                    boolean,
    "disabled"                  boolean DEFAULT false,
    "skipConsent"               boolean,
    "enableEndSession"          boolean,
    "subjectType"               text,
    "requirePKCE"               boolean,
    "uri"                       text,
    "contacts"                  text[],
    "tos"                       text,
    "policy"                    text,
    "softwareId"                text,
    "softwareVersion"           text,
    "softwareStatement"         text,
    "backchannelLogoutUri"      text,
    "backchannelLogoutSessionRequired" boolean,
    "applicationType"           text,
    "jwks"                      text,
    "jwksUri"                   text,
    "dpopBoundAccessTokens"     boolean DEFAULT false,
    "referenceId"               text,
    "userId"                    uuid REFERENCES "user"("id") ON DELETE CASCADE,
    "createdAt"                 timestamptz NOT NULL DEFAULT now(),
    "updatedAt"                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "oauthResource" (
    "id"                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "identifier"                      text NOT NULL UNIQUE,
    "name"                            text NOT NULL,
    "accessTokenTtl"                  integer,
    "refreshTokenTtl"                 integer,
    "signingAlgorithm"                text,
    "signingKeyId"                    text,
    "allowedScopes"                   text[],
    "customClaims"                    jsonb,
    "dpopBoundAccessTokensRequired"   boolean DEFAULT false,
    "disabled"                        boolean DEFAULT false,
    "createdAt"                       timestamptz DEFAULT now(),
    "updatedAt"                       timestamptz DEFAULT now(),
    "policyVersion"                   integer DEFAULT 1,
    "metadata"                        jsonb
);

CREATE TABLE IF NOT EXISTS "oauthClientResource" (
    "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "clientId"      text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
    "resourceId"    text NOT NULL REFERENCES "oauthResource"("identifier") ON DELETE CASCADE,
    "metadata"      jsonb,
    "createdAt"     timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
    "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "token"         text NOT NULL,
    "clientId"      text NOT NULL,
    "sessionId"     uuid,
    "refreshId"     uuid,
    "userId"        uuid REFERENCES "user"("id") ON DELETE CASCADE,
    "referenceId"   text,
    "authorizationCodeId" text,
    "resources"     text[],
    "requestedUserInfoClaims" text[],
    "scopes"        text[] NOT NULL,
    "createdAt"     timestamptz NOT NULL DEFAULT now(),
    "expiresAt"     timestamptz NOT NULL,
    "revoked"       timestamptz,
    "confirmation"  jsonb
);

CREATE TABLE IF NOT EXISTS "oauthRefreshToken" (
    "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "token"         text NOT NULL,
    "clientId"      text NOT NULL,
    "sessionId"     uuid,
    "userId"        uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "referenceId"   text,
    "authorizationCodeId" text,
    "resources"     text[],
    "requestedUserInfoClaims" text[],
    "scopes"        text[] NOT NULL,
    "revoked"       timestamptz,
    "rotatedAt"     timestamptz,
    "rotationReplayResponse" text,
    "rotationReplayExpiresAt" timestamptz,
    "authTime"      timestamptz,
    "confirmation"  jsonb,
    "createdAt"     timestamptz NOT NULL DEFAULT now(),
    "expiresAt"     timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "oauthConsent" (
    "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "clientId"      text NOT NULL,
    "userId"        uuid REFERENCES "user"("id") ON DELETE CASCADE,
    "referenceId"   text,
    "resources"     text[],
    "requestedUserInfoClaims" text[],
    "scopes"        text[] NOT NULL,
    "createdAt"     timestamptz NOT NULL DEFAULT now(),
    "updatedAt"     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "oauthClientAssertion" (
    "id"          text PRIMARY KEY,
    "expiresAt"   timestamptz NOT NULL
);

-- Better Auth OAuth Provider 1.7 expansion for existing installations.
ALTER TABLE "oauthClient" ADD COLUMN IF NOT EXISTS "clientDiscoveryId" text;
ALTER TABLE "oauthClient" ADD COLUMN IF NOT EXISTS "clientCredentialsScopes" text[] DEFAULT '{}';
ALTER TABLE "oauthClient" ADD COLUMN IF NOT EXISTS "backchannelLogoutUri" text;
ALTER TABLE "oauthClient" ADD COLUMN IF NOT EXISTS "backchannelLogoutSessionRequired" boolean;
ALTER TABLE "oauthClient" ADD COLUMN IF NOT EXISTS "applicationType" text;
ALTER TABLE "oauthClient" ADD COLUMN IF NOT EXISTS "jwks" text;
ALTER TABLE "oauthClient" ADD COLUMN IF NOT EXISTS "jwksUri" text;
ALTER TABLE "oauthClient" ADD COLUMN IF NOT EXISTS "dpopBoundAccessTokens" boolean DEFAULT false;

UPDATE "oauthClient"
SET "clientCredentialsScopes" = '{}'
WHERE "clientCredentialsScopes" IS NULL;

UPDATE "oauthClient"
SET "applicationType" = "type"
WHERE "applicationType" IS NULL
  AND "type" IN ('web', 'native');

UPDATE "oauthClient"
SET "tokenEndpointAuthMethod" = 'none'
WHERE "public" IS TRUE
  AND "tokenEndpointAuthMethod" IS NULL;

ALTER TABLE "oauthAccessToken" ADD COLUMN IF NOT EXISTS "authorizationCodeId" text;
ALTER TABLE "oauthAccessToken" ADD COLUMN IF NOT EXISTS "resources" text[];
ALTER TABLE "oauthAccessToken" ADD COLUMN IF NOT EXISTS "requestedUserInfoClaims" text[];
ALTER TABLE "oauthAccessToken" ADD COLUMN IF NOT EXISTS "revoked" timestamptz;
ALTER TABLE "oauthAccessToken" ADD COLUMN IF NOT EXISTS "confirmation" jsonb;

ALTER TABLE "oauthRefreshToken" ADD COLUMN IF NOT EXISTS "authorizationCodeId" text;
ALTER TABLE "oauthRefreshToken" ADD COLUMN IF NOT EXISTS "resources" text[];
ALTER TABLE "oauthRefreshToken" ADD COLUMN IF NOT EXISTS "requestedUserInfoClaims" text[];
ALTER TABLE "oauthRefreshToken" ADD COLUMN IF NOT EXISTS "rotatedAt" timestamptz;
ALTER TABLE "oauthRefreshToken" ADD COLUMN IF NOT EXISTS "rotationReplayResponse" text;
ALTER TABLE "oauthRefreshToken" ADD COLUMN IF NOT EXISTS "rotationReplayExpiresAt" timestamptz;
ALTER TABLE "oauthRefreshToken" ADD COLUMN IF NOT EXISTS "confirmation" jsonb;

ALTER TABLE "oauthConsent" ADD COLUMN IF NOT EXISTS "resources" text[];
ALTER TABLE "oauthConsent" ADD COLUMN IF NOT EXISTS "requestedUserInfoClaims" text[];

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauthAccessToken_clientId_fk'
      AND conrelid = '"oauthAccessToken"'::regclass
      AND confdeltype <> 'c'
  ) THEN
    ALTER TABLE "oauthAccessToken" DROP CONSTRAINT "oauthAccessToken_clientId_fk";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauthAccessToken_clientId_fk'
      AND conrelid = '"oauthAccessToken"'::regclass
  ) THEN
    ALTER TABLE "oauthAccessToken"
      ADD CONSTRAINT "oauthAccessToken_clientId_fk"
      FOREIGN KEY ("clientId") REFERENCES "oauthClient"("clientId") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauthAccessToken_sessionId_fk'
      AND conrelid = '"oauthAccessToken"'::regclass
  ) THEN
    ALTER TABLE "oauthAccessToken"
      ADD CONSTRAINT "oauthAccessToken_sessionId_fk"
      FOREIGN KEY ("sessionId") REFERENCES "session"("id") ON DELETE SET NULL NOT VALID;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauthAccessToken_refreshId_fk'
      AND conrelid = '"oauthAccessToken"'::regclass
      AND confdeltype <> 'c'
  ) THEN
    ALTER TABLE "oauthAccessToken" DROP CONSTRAINT "oauthAccessToken_refreshId_fk";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauthAccessToken_refreshId_fk'
      AND conrelid = '"oauthAccessToken"'::regclass
  ) THEN
    ALTER TABLE "oauthAccessToken"
      ADD CONSTRAINT "oauthAccessToken_refreshId_fk"
      FOREIGN KEY ("refreshId") REFERENCES "oauthRefreshToken"("id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauthRefreshToken_clientId_fk'
      AND conrelid = '"oauthRefreshToken"'::regclass
      AND confdeltype <> 'c'
  ) THEN
    ALTER TABLE "oauthRefreshToken" DROP CONSTRAINT "oauthRefreshToken_clientId_fk";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauthRefreshToken_clientId_fk'
      AND conrelid = '"oauthRefreshToken"'::regclass
  ) THEN
    ALTER TABLE "oauthRefreshToken"
      ADD CONSTRAINT "oauthRefreshToken_clientId_fk"
      FOREIGN KEY ("clientId") REFERENCES "oauthClient"("clientId") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauthRefreshToken_sessionId_fk'
      AND conrelid = '"oauthRefreshToken"'::regclass
  ) THEN
    ALTER TABLE "oauthRefreshToken"
      ADD CONSTRAINT "oauthRefreshToken_sessionId_fk"
      FOREIGN KEY ("sessionId") REFERENCES "session"("id") ON DELETE SET NULL NOT VALID;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauthConsent_clientId_fk'
      AND conrelid = '"oauthConsent"'::regclass
      AND confdeltype <> 'c'
  ) THEN
    ALTER TABLE "oauthConsent" DROP CONSTRAINT "oauthConsent_clientId_fk";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauthConsent_clientId_fk'
      AND conrelid = '"oauthConsent"'::regclass
  ) THEN
    ALTER TABLE "oauthConsent"
      ADD CONSTRAINT "oauthConsent_clientId_fk"
      FOREIGN KEY ("clientId") REFERENCES "oauthClient"("clientId") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "oauthClient_clientId_uidx" ON "oauthClient"("clientId");
CREATE INDEX IF NOT EXISTS "oauthClient_userId_idx" ON "oauthClient"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "oauthResource_identifier_uidx" ON "oauthResource"("identifier");
CREATE INDEX IF NOT EXISTS "oauthClientResource_clientId_idx" ON "oauthClientResource"("clientId");
CREATE INDEX IF NOT EXISTS "oauthClientResource_resourceId_idx" ON "oauthClientResource"("resourceId");
CREATE UNIQUE INDEX IF NOT EXISTS "oauthClientResource_clientId_resourceId_uidx" ON "oauthClientResource"("clientId", "resourceId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_clientId_idx" ON "oauthAccessToken"("clientId");
CREATE UNIQUE INDEX IF NOT EXISTS "oauthAccessToken_token_uidx" ON "oauthAccessToken"("token");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_sessionId_idx" ON "oauthAccessToken"("sessionId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_userId_idx" ON "oauthAccessToken"("userId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken"("authorizationCodeId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_refreshId_idx" ON "oauthAccessToken"("refreshId");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken"("clientId");
CREATE UNIQUE INDEX IF NOT EXISTS "oauthRefreshToken_token_uidx" ON "oauthRefreshToken"("token");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken"("sessionId");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_userId_idx" ON "oauthRefreshToken"("userId");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken"("authorizationCodeId");
CREATE INDEX IF NOT EXISTS "oauthConsent_clientId_idx" ON "oauthConsent"("clientId");
CREATE INDEX IF NOT EXISTS "oauthConsent_userId_idx" ON "oauthConsent"("userId");
