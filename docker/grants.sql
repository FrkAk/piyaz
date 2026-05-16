-- =============================================================================
-- Canonical GRANT/REVOKE for the three-role split (app_user, service_role,
-- auth_role). Single source of truth — consumed by:
--   * docker/init-rls.sh                       (self-host bootstrap, `\i`)
--   * tests/setup/migrate.ts                   (testcontainer, readFileSync)
--   * docs/neon-prod-provisioning.sql          (Neon prod runbook, pointer)
--
-- Scope: schema/table/sequence grants and default privileges only.
-- Out of scope here (kept in each consumer because they vary per context):
--   * CREATE ROLE — passwords flow from env / Neon console / test fixture
--   * GRANT CREATE ON DATABASE "<db>" — DB name varies (POSTGRES_DB / neondb)
--   * CREATE SCHEMA drizzle — only needed when `drizzle-kit migrate` runs
--     (self-host + Neon prod). Testcontainer uses `drizzle-kit push` which
--     does not provision the migrations schema.
--
-- Idempotent. Safe to re-run.
-- =============================================================================

-- CVE-2018-1058 hardening note: TEMPORARY privilege on the database is
-- revoked from PUBLIC. Because REVOKE TEMPORARY requires a concrete
-- database name (no function-call form), the statement lives in two
-- context-aware locations rather than this file:
--   * docker/init-rls.sh             (self-host / testcontainer)
--   * docs/neon-prod-provisioning.sql section 8 (Neon prod runbook)

-- public schema: app_user runs every query under RLS; service_role bypasses.
GRANT USAGE ON SCHEMA public TO app_user, service_role;
GRANT CREATE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE service_role IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE service_role IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- neon_auth: app_user reaches it only via SECURITY DEFINER functions in
-- docker/rls-functions.sql. Explicit REVOKEs keep re-runs idempotent when
-- upgrading from the pre-lockdown provisioning.
GRANT USAGE ON SCHEMA neon_auth TO service_role, auth_role;
REVOKE ALL ON SCHEMA neon_auth FROM app_user;
REVOKE ALL ON ALL TABLES IN SCHEMA neon_auth FROM app_user;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA neon_auth FROM app_user;

-- service_role: tight set on neon_auth (used only by clearOrgMembershipArtifacts).
GRANT SELECT, REFERENCES ON neon_auth."member" TO service_role;
GRANT SELECT, REFERENCES ON neon_auth.organization TO service_role;
GRANT SELECT, REFERENCES ON neon_auth."user" TO service_role;
GRANT SELECT, REFERENCES ON neon_auth.invitation TO service_role;
GRANT SELECT, UPDATE ON neon_auth."session" TO service_role;
GRANT SELECT, DELETE ON neon_auth."oauthAccessToken" TO service_role;
GRANT SELECT, DELETE ON neon_auth."oauthRefreshToken" TO service_role;
GRANT SELECT, DELETE ON neon_auth."oauthConsent" TO service_role;

-- auth_role: full DML on every neon_auth table (Better Auth runtime connection).
-- No grants on public; auth_role cannot touch app data even under SQLi.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA neon_auth TO auth_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA neon_auth TO auth_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA neon_auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO auth_role;
