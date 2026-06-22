-- OAuth 2.1 Provider tables for @better-auth/oauth-provider.
-- Run once against the piyaz_auth schema on hosted Neon.
-- Self-hosted path: these tables are in docker/init-auth.sql instead.

SET search_path TO piyaz_auth;

CREATE TABLE "oauthClient" (
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

CREATE TABLE "oauthAccessToken" (
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

CREATE TABLE "oauthRefreshToken" (
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

CREATE TABLE "oauthConsent" (
    "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "clientId"      text NOT NULL,
    "userId"        uuid REFERENCES "user"("id") ON DELETE CASCADE,
    "referenceId"   text,
    "scopes"        text[] NOT NULL,
    "createdAt"     timestamptz NOT NULL DEFAULT now(),
    "updatedAt"     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "oauthClient_clientId_uidx" ON "oauthClient"("clientId");
CREATE INDEX "oauthClient_userId_idx" ON "oauthClient"("userId");
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken"("clientId");
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken"("userId");
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken"("clientId");
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken"("userId");
CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent"("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent"("userId");
