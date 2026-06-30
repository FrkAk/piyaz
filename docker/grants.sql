-- =============================================================================
-- Public-schema GRANT/REVOKE for the app_user / service_role split. Owned by
-- the role that owns `public`, so it is safe to (re-)apply with the migration
-- role. Consumed by docker/init-rls.sh (self-host), tests/setup/migrate.ts
-- (testcontainer), and scripts/apply-public-rls.ts (re-applied after migrate).
-- Idempotent.
--
-- The piyaz_auth grants live in docker/grants-auth.sql (owner-only). Out of
-- scope here (varies per consumer): CREATE ROLE, GRANT CREATE ON DATABASE,
-- CREATE SCHEMA drizzle, REVOKE TEMPORARY (database name varies).
-- =============================================================================

-- public schema: app_user under RLS, service_role bypasses.
--
-- No `ALTER DEFAULT PRIVILEGES`: it would auto-grant DML on a future table
-- BEFORE its migration could ENABLE RLS — a stealth leak between CREATE
-- TABLE and the policy attach. Grants are schema-wide (`ON ALL TABLES`) and
-- re-applied after each migrate, so a new public table is covered without a
-- per-table grant. A missing grant is a loud runtime failure; a missing RLS
-- attach is caught by rls-coverage.test.ts.
--
-- CVE-2018-1058 belt: REVOKE CREATE prevents any role from installing a
-- shadow function in schema public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_user, service_role;
GRANT CREATE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user, service_role;

-- note_revisions is an append-only audit/rollback trail: app_user may INSERT
-- and DELETE but never UPDATE a snapshot. Runs after the schema-wide GRANT
-- above so it narrows it; re-applied with it.
REVOKE UPDATE ON public.note_revisions FROM app_user;
