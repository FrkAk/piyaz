-- =============================================================================
-- Canonical GRANT/REVOKE for the three-role split (app_user, service_role,
-- auth_role). Consumed by docker/init-rls.sh (self-host) and
-- tests/setup/migrate.ts (testcontainer). Idempotent.
--
-- Out of scope (varies per consumer): CREATE ROLE, GRANT CREATE ON
-- DATABASE, CREATE SCHEMA drizzle, REVOKE TEMPORARY (database name varies).
-- =============================================================================

-- public schema: app_user under RLS, service_role bypasses.
--
-- No `ALTER DEFAULT PRIVILEGES`: it would auto-grant DML on a future table
-- BEFORE its migration could ENABLE RLS — a stealth leak between CREATE
-- TABLE and the policy attach. New public tables must add explicit grants:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO app_user, service_role;
--   GRANT USAGE, SELECT ON <table>_id_seq TO app_user, service_role;
-- A missing grant is a loud runtime failure; a missing RLS attach is
-- caught by rls-coverage.test.ts.
--
-- CVE-2018-1058 belt: REVOKE CREATE prevents any role from installing a
-- shadow function in schema public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_user, service_role;
GRANT CREATE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user, service_role;

-- Explicit per-table grant for activity_events (the documented convention for
-- new public tables; the schema-wide grant above only covers tables that
-- exist when it runs).
GRANT SELECT, INSERT, UPDATE, DELETE ON "activity_events" TO app_user, service_role;

-- piyaz_auth: app_user reaches it only via SECURITY DEFINER functions.
-- Explicit REVOKEs make re-runs idempotent on pre-lockdown installs.
GRANT USAGE ON SCHEMA piyaz_auth TO service_role, auth_role;
REVOKE ALL ON SCHEMA piyaz_auth FROM app_user;
REVOKE ALL ON ALL TABLES IN SCHEMA piyaz_auth FROM app_user;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA piyaz_auth FROM app_user;

-- service_role: minimal set on piyaz_auth — used by
-- clearOrgMembershipArtifacts and the OAuth-session settings UI.
GRANT SELECT, REFERENCES ON piyaz_auth."member" TO service_role;
GRANT SELECT, REFERENCES ON piyaz_auth.organization TO service_role;
GRANT SELECT, REFERENCES ON piyaz_auth."user" TO service_role;
GRANT SELECT, REFERENCES ON piyaz_auth.invitation TO service_role;
GRANT SELECT, UPDATE ON piyaz_auth."session" TO service_role;
GRANT SELECT, DELETE ON piyaz_auth."oauthAccessToken" TO service_role;
-- UPDATE: revokeOAuthSession soft-revokes (`revoked = now()`) before
-- cascading the access-token delete in the same tx.
GRANT SELECT, UPDATE, DELETE ON piyaz_auth."oauthRefreshToken" TO service_role;
GRANT SELECT, DELETE ON piyaz_auth."oauthConsent" TO service_role;
-- SELECT only; writes go through auth_role.
GRANT SELECT ON piyaz_auth."oauthClient" TO service_role;

-- auth_role: full DML on piyaz_auth, zero grants on public. No
-- ALTER DEFAULT PRIVILEGES — same RLS-race rationale as the public block.
-- New piyaz_auth tables need explicit grants in their migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA piyaz_auth TO auth_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA piyaz_auth TO auth_role;
