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
    "expiresAt"    timestamptz
);

-- Indexes
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("userId");
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
    "name"                      text,
    "icon"                      text,
    "metadata"                  text,
    "redirectUris"              text[] NOT NULL,
    "postLogoutRedirectUris"    text[],
    "tokenEndpointAuthMethod"   text,
    "grantTypes"                text[],
    "responseTypes"             text[],
    "scopes"                    text[],
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
    "referenceId"               text,
    "userId"                    uuid REFERENCES "user"("id") ON DELETE CASCADE,
    "createdAt"                 timestamptz NOT NULL DEFAULT now(),
    "updatedAt"                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
    "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "token"         text NOT NULL,
    "clientId"      text NOT NULL,
    "sessionId"     uuid,
    "refreshId"     uuid,
    "userId"        uuid REFERENCES "user"("id") ON DELETE CASCADE,
    "referenceId"   text,
    "scopes"        text[] NOT NULL,
    "createdAt"     timestamptz NOT NULL DEFAULT now(),
    "expiresAt"     timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "oauthRefreshToken" (
    "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "token"         text NOT NULL,
    "clientId"      text NOT NULL,
    "sessionId"     uuid,
    "userId"        uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "referenceId"   text,
    "scopes"        text[] NOT NULL,
    "revoked"       timestamptz,
    "authTime"      timestamptz,
    "createdAt"     timestamptz NOT NULL DEFAULT now(),
    "expiresAt"     timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "oauthConsent" (
    "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "clientId"      text NOT NULL,
    "userId"        uuid REFERENCES "user"("id") ON DELETE CASCADE,
    "referenceId"   text,
    "scopes"        text[] NOT NULL,
    "createdAt"     timestamptz NOT NULL DEFAULT now(),
    "updatedAt"     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "oauthClient_clientId_uidx" ON "oauthClient"("clientId");
CREATE INDEX IF NOT EXISTS "oauthClient_userId_idx" ON "oauthClient"("userId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_clientId_idx" ON "oauthAccessToken"("clientId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_userId_idx" ON "oauthAccessToken"("userId");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken"("clientId");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_userId_idx" ON "oauthRefreshToken"("userId");
CREATE INDEX IF NOT EXISTS "oauthConsent_clientId_idx" ON "oauthConsent"("clientId");
CREATE INDEX IF NOT EXISTS "oauthConsent_userId_idx" ON "oauthConsent"("userId");
