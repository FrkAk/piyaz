-- =============================================================================
-- MYMR-151 Neon prod provisioning
-- Project: ancient-scene-55031748 (Mymir)
-- Date: 2026-05-15
-- Runs against: production Neon main branch
--
-- Order matters. Statements marked [UI-ONLY] cannot be run via SQL on Neon
-- because they require SUPERUSER (only cloud_admin is). Use Neon console's
-- role-management panel for those. Everything else runs fine as neondb_owner
-- via the Neon SQL editor or via this app's Neon MCP / psql connection.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. ROLES
-- -----------------------------------------------------------------------------
-- These two CREATE ROLE statements are the SQL equivalent of what the Neon
-- console UI does, but on Neon you cannot run them via SQL with these explicit
-- attributes (permission denied: only cloud_admin can set BYPASSRLS etc.).
-- On Neon: create via "Add role" in the console, then toggle attributes in
-- the role-detail panel. On self-hosted Postgres or another platform where
-- the migration role IS a superuser, these statements run as-is.
-- -----------------------------------------------------------------------------

-- [UI-ONLY on Neon] runtime app role, RLS-enforcing
CREATE ROLE app_user WITH
    LOGIN
    INHERIT
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS
    PASSWORD '<set-via-neon-console>';

-- [UI-ONLY on Neon] service bypass role, used by 4 functions only
CREATE ROLE service_role WITH
    LOGIN
    INHERIT
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    BYPASSRLS
    PASSWORD '<set-via-neon-console>';


-- -----------------------------------------------------------------------------
-- 2. SCHEMA-LEVEL GRANTS (runs as neondb_owner -- no special perms needed)
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO app_user, service_role;
GRANT USAGE ON SCHEMA neon_auth TO app_user, service_role;

-- service_role only: lets `drizzle-kit push` create new tables when migrating
-- via DATABASE_SERVICE_ROLE_URL. app_user must NEVER have CREATE on public.
GRANT CREATE ON SCHEMA public TO service_role;


-- -----------------------------------------------------------------------------
-- 3. TABLE-LEVEL GRANTS (existing tables)
-- -----------------------------------------------------------------------------

-- public: full DML on the 8 RLS-protected tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
    TO app_user, service_role;

-- neon_auth: SELECT only.
-- Both roles need SELECT on neon_auth.member for RLS policy evaluation
-- (the EXISTS subquery in policy USING clauses joins through member).
-- service_role also reads neon_auth tables for clearOrgMembershipArtifacts.
-- Writes to neon_auth.* are owned by Better Auth's separate authDb client.
GRANT SELECT ON ALL TABLES IN SCHEMA neon_auth
    TO app_user, service_role;


-- -----------------------------------------------------------------------------
-- 4. DEFAULT PRIVILEGES (future tables created by neondb_owner)
-- -----------------------------------------------------------------------------
-- When `drizzle-kit migrate` creates new tables (it runs as service_role, which
-- has CREATE on schema public), they automatically get the same DML grants.
-- Without this, every migration would need a follow-up GRANT.
-- -----------------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
    TO app_user, service_role;


-- -----------------------------------------------------------------------------
-- 5. SEQUENCES (current + default)
-- -----------------------------------------------------------------------------
-- Insurance for any drizzle-generated serial PKs. Mymir's schema uses
-- gen_random_uuid() for IDs today, but this future-proofs the grants.
-- -----------------------------------------------------------------------------

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
    TO app_user, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES
    TO app_user, service_role;


-- -----------------------------------------------------------------------------
-- 6. CROSS-SCHEMA REFERENCES + drizzle-kit migrate prerequisites
-- -----------------------------------------------------------------------------
-- These were added after the initial provisioning when the implementer
-- discovered drizzle-kit's runtime requirements during MYMR-151 implementation:
--   (a) Catalog introspection on cross-schema foreign keys
--       (e.g. public.projects.organization_id -> neon_auth.organization) fails
--       with "permission denied for table organization" without REFERENCES
--       privilege on neon_auth.*. SELECT alone is insufficient for FK resolution.
--   (b) `drizzle-kit migrate` issues `CREATE SCHEMA IF NOT EXISTS drizzle`
--       unconditionally to provision its own migrations-tracking schema. This
--       requires CREATE on the database itself (not just on schema public).
--       Pre-creating the drizzle schema + granting service_role on it avoids
--       the per-migration permission check.
-- -----------------------------------------------------------------------------

-- (a) REFERENCES on cross-schema target tables
GRANT REFERENCES ON ALL TABLES IN SCHEMA neon_auth TO app_user, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA neon_auth
    GRANT REFERENCES ON TABLES TO app_user, service_role;

-- (b) drizzle-kit migrate's tracking schema
GRANT CREATE ON DATABASE neondb TO service_role;
CREATE SCHEMA IF NOT EXISTS drizzle;
GRANT USAGE, CREATE ON SCHEMA drizzle TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;


-- -----------------------------------------------------------------------------
-- 7. COMPOSITE INDEX for RLS predicate performance
-- -----------------------------------------------------------------------------
-- All 8 RLS policies dispatch via:
--   EXISTS (SELECT 1 FROM neon_auth.member m
--           WHERE m.organization_id = projects.organization_id
--             AND m.user_id = current_setting('app.user_id', TRUE)::uuid)
-- Individual indexes on organization_id and user_id exist, but a composite
-- speeds the policy predicate to a single index lookup per row evaluated.
-- Idempotent.
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS member_org_user_idx
    ON neon_auth."member" ("organizationId", "userId");


-- =============================================================================
-- VERIFICATION QUERIES (read-only; safe to re-run anytime)
-- =============================================================================

-- Confirm role attributes (expected: app_user.rolbypassrls=false; service_role.rolbypassrls=true)
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
       rolreplication, rolinherit, rolcanlogin
FROM pg_roles
WHERE rolname IN ('app_user', 'service_role')
ORDER BY rolname;

-- Confirm no leftover neon_superuser membership (expected: empty result)
SELECT r.rolname AS role, gr.rolname AS member_of
FROM pg_auth_members m
JOIN pg_roles r ON r.oid = m.member
JOIN pg_roles gr ON gr.oid = m.roleid
WHERE r.rolname IN ('app_user', 'service_role')
ORDER BY r.rolname, gr.rolname;

-- Confirm public table grants (expected: 4 rows per role per table)
SELECT grantee, table_name,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
FROM information_schema.table_privileges
WHERE grantee IN ('app_user', 'service_role')
  AND table_schema = 'public'
GROUP BY grantee, table_name
ORDER BY table_name, grantee;

-- Confirm neon_auth grants (expected: SELECT only)
SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.table_privileges
WHERE grantee IN ('app_user', 'service_role')
  AND table_schema = 'neon_auth'
ORDER BY grantee, table_name;

-- Confirm composite index exists (expected: one row)
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'neon_auth'
  AND tablename = 'member'
  AND indexname = 'member_org_user_idx';
