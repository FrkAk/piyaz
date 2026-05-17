-- =============================================================================
-- Canonical GRANT/REVOKE for the three-role split (app_user, service_role,
-- auth_role). Single source of truth, consumed by:
--   * docker/init-rls.sh                       (self-host bootstrap, `\i`)
--   * tests/setup/migrate.ts                   (testcontainer, readFileSync)
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
-- revoked from PUBLIC inside docker/init-rls.sh (self-host / testcontainer).
-- Kept there because REVOKE TEMPORARY requires a concrete database name and
-- POSTGRES_DB varies per context.

-- public schema: app_user runs every query under RLS; service_role bypasses.
--
-- No `ALTER DEFAULT PRIVILEGES` on the public schema. Default privileges
-- would auto-grant DML on any future table at CREATE TIME, BEFORE the
-- migration has had a chance to `ALTER TABLE … ENABLE ROW LEVEL SECURITY`
-- + attach policies. A new table would be reachable from app_user with no
-- RLS protection for the window between CREATE TABLE and ENABLE RLS — a
-- stealth data leak.
--
-- New public tables MUST receive explicit grants in their migration:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO app_user, service_role;
--   GRANT USAGE, SELECT ON <table>_id_seq TO app_user, service_role;  -- if applicable
-- The `rls-coverage.test.ts` invariant catches a missing RLS attach. A
-- missing grant is a LOUD failure (queries error on first hit), not a
-- stealth failure, so the trade is asymmetric in our favor.
--
-- CVE-2018-1058 belt: revoke CREATE on schema public from PUBLIC. PG ≤ 14
-- grants this by default; PG 15+ removes the default but the bootstrap
-- should not depend on server version. With CREATE revoked, no role
-- (including future ones inheriting from PUBLIC) can install a function
-- in schema public — eliminating the "shadow public.current_user_org_ids()"
-- attack surface entirely. Combined with `pg_temp` pinned last in every
-- SDF's search_path and `REVOKE TEMPORARY ON DATABASE ... FROM PUBLIC`,
-- this is the third leg of the CVE-2018-1058 defense.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_user, service_role;
GRANT CREATE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user, service_role;

-- neon_auth: app_user reaches it only via SECURITY DEFINER functions in
-- docker/rls-functions.sql. Explicit REVOKEs keep re-runs idempotent when
-- upgrading from the pre-lockdown provisioning.
GRANT USAGE ON SCHEMA neon_auth TO service_role, auth_role;
REVOKE ALL ON SCHEMA neon_auth FROM app_user;
REVOKE ALL ON ALL TABLES IN SCHEMA neon_auth FROM app_user;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA neon_auth FROM app_user;

-- service_role: tight set on neon_auth (used only by clearOrgMembershipArtifacts
-- and the OAuth-session settings UI).
GRANT SELECT, REFERENCES ON neon_auth."member" TO service_role;
GRANT SELECT, REFERENCES ON neon_auth.organization TO service_role;
GRANT SELECT, REFERENCES ON neon_auth."user" TO service_role;
GRANT SELECT, REFERENCES ON neon_auth.invitation TO service_role;
GRANT SELECT, UPDATE ON neon_auth."session" TO service_role;
GRANT SELECT, DELETE ON neon_auth."oauthAccessToken" TO service_role;
-- UPDATE: revokeOAuthSession sets `revoked = now()` (soft revoke) before
-- cascading the access-token delete in the same tx.
GRANT SELECT, UPDATE, DELETE ON neon_auth."oauthRefreshToken" TO service_role;
GRANT SELECT, DELETE ON neon_auth."oauthConsent" TO service_role;
-- SELECT only: listActiveOAuthSessions LEFT JOINs to surface `clientName`
-- in the settings UI. No INSERT/UPDATE/DELETE (Better Auth owns writes via auth_role).
GRANT SELECT ON neon_auth."oauthClient" TO service_role;

-- auth_role: full DML on every neon_auth table (Better Auth runtime connection).
-- No grants on public; auth_role cannot touch app data even under SQLi.
--
-- No `ALTER DEFAULT PRIVILEGES` on schema neon_auth. Same RLS-race rationale
-- as the public-schema block above (H2): default privileges would auto-grant
-- DML on any future neon_auth table at CREATE TIME, before the migration
-- could attach RLS or audit-only controls. Better Auth's schema is stable
-- and managed via @better-auth/cli's drizzle adapter; new neon_auth tables
-- (if/when they appear) must receive an explicit
--   GRANT SELECT, INSERT, UPDATE, DELETE ON neon_auth.<table> TO auth_role;
-- in the migration that introduces them. Lower blast radius than H2 because
-- auth_role has zero grants on the public schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA neon_auth TO auth_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA neon_auth TO auth_role;
