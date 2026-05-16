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
--
-- Canonical schema/table/sequence grants live in docker/grants.sql. The
-- self-host bootstrap (docker/init-rls.sh) and the testcontainer
-- (tests/setup/migrate.ts) consume the same file, so updates land in one
-- place and parity holds across prod / self-host / test.
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

-- [UI-ONLY on Neon] Better Auth runtime role, DML on neon_auth.* only
CREATE ROLE auth_role WITH
    LOGIN
    INHERIT
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS
    PASSWORD '<set-via-neon-console>';


-- -----------------------------------------------------------------------------
-- 2. SCHEMA / TABLE / SEQUENCE GRANTS — apply docker/grants.sql
-- -----------------------------------------------------------------------------
-- Run docker/grants.sql as neondb_owner (Neon SQL editor, Neon MCP, or psql).
-- That file is the single source of truth for:
--   * public schema USAGE + CREATE
--   * public DML on all tables + sequences + default privileges
--   * neon_auth USAGE + REVOKE-from-app_user (Option B lockdown)
--   * neon_auth tight grants for service_role
--   * neon_auth full DML + default privileges for auth_role
-- See sections 1, 3-7 below for context-specific steps not covered by
-- grants.sql (role creation, DB-level grants, drizzle migrations schema,
-- composite index, SECURITY DEFINER functions, smoke tests).
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- 3. drizzle-kit migrate prerequisites
-- -----------------------------------------------------------------------------
-- Added after the initial provisioning when the implementer discovered
-- drizzle-kit's runtime requirements during MYMR-151 implementation:
--   `drizzle-kit migrate` issues `CREATE SCHEMA IF NOT EXISTS drizzle`
--   unconditionally to provision its own migrations-tracking schema. This
--   requires CREATE on the database itself (not just on schema public).
--   Pre-creating the drizzle schema + granting service_role on it avoids
--   the per-migration permission check.
-- -----------------------------------------------------------------------------

GRANT CREATE ON DATABASE neondb TO service_role;
CREATE SCHEMA IF NOT EXISTS drizzle;
GRANT USAGE, CREATE ON SCHEMA drizzle TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;


-- -----------------------------------------------------------------------------
-- 4. COMPOSITE INDEX for RLS predicate performance
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


-- -----------------------------------------------------------------------------
-- 5. VERIFY app_user has NO grants on ANY neon_auth table (Option B lockdown)
-- -----------------------------------------------------------------------------
-- Expected: empty result (zero rows). Under Option B app_user is REVOKED
-- from every neon_auth table — all reads route through SECURITY DEFINER
-- functions in docker/rls-functions.sql.
SELECT grantee, table_name, privilege_type
FROM information_schema.table_privileges
WHERE grantee = 'app_user'
  AND table_schema = 'neon_auth';


-- -----------------------------------------------------------------------------
-- 6. SECURITY DEFINER functions
-- -----------------------------------------------------------------------------
-- Apply by running docker/rls-functions.sql as neondb_owner via the Neon SQL
-- editor or psql. The function bodies are reviewed alongside
-- docker/rls-functions.sql; this section is a pointer (not a duplicate) so
-- the prod runbook stays the single source of truth for what runs on Neon.
--
-- Functions installed (invite-code flow):
--   public.lookup_team_invite_code(text)
--   public.reserve_team_invite_code_slot(text)
--   public.release_team_invite_code_slot(uuid)
--
-- Functions installed (Option B — neon_auth lockdown, grants to app_user):
--   public.current_user_org_ids()              -- uuid[]; RLS policy hot path
--   public.current_user_org_role(uuid)         -- text role or NULL
--   public.current_user_orgs()                 -- caller's org summary
--   public.current_user_has_any_membership()   -- bool, drives /onboarding
--   public.current_user_visible_member(uuid)   -- single member, cross-team scoped
--   public.team_member_roles_visible(uuid)     -- last-owner guard data
--   public.team_members_visible(uuid)          -- team roster
--   public.team_invitations_visible(uuid)      -- admin-gated invitations
--   public.lookup_user_names_in_shared_orgs(uuid[]) -- batched name lookup
--
-- Functions installed (admin/system, service_role only):
--   public.list_org_project_ids(uuid)
--   public.find_org_member_user_ids_as_admin(uuid)
--
-- EXECUTE granted to app_user only.
-- -----------------------------------------------------------------------------

-- [Apply docker/rls-functions.sql as neondb_owner]


-- [PROD UPDATE 2026-05-15] team_invite_code policy split for admin-only writes.
-- The previous member-access policy let any org member INSERT/UPDATE/DELETE
-- invite codes via direct SQL. Apply by re-running docker/rls-policies.sql
-- against the Neon prod database.

-- [PROD UPDATE 2026-05-15] Added list_org_project_ids(uuid) SECURITY DEFINER
-- function for revokeOrgAccess. Apply by re-running docker/rls-functions.sql
-- against the Neon prod database.


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

-- Confirm neon_auth grants per role
-- Expected:
--   app_user: SELECT + REFERENCES on member/organization/user/invitation only (8 rows: 4 tables × 2 privs)
--   service_role: same as app_user, PLUS SELECT/UPDATE on session, SELECT/DELETE on oauth* tables
--   auth_role: SELECT/INSERT/UPDATE/DELETE on every neon_auth table
SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.table_privileges
WHERE grantee IN ('app_user', 'service_role', 'auth_role')
  AND table_schema = 'neon_auth'
ORDER BY grantee, table_name, privilege_type;

-- Confirm composite index exists (expected: one row)
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'neon_auth'
  AND tablename = 'member'
  AND indexname = 'member_org_user_idx';


-- -----------------------------------------------------------------------------
-- 7. SMOKE TEST after prod flip
-- -----------------------------------------------------------------------------
-- Run these queries from the Neon SQL editor connected as neondb_owner AFTER
-- flipping DATABASE_URL to point at app_user. Expected results below each
-- query show what each role can and cannot see.
-- -----------------------------------------------------------------------------

-- (a) confirm a SELECT from neon_auth.account as app_user is denied
SET ROLE app_user;
SELECT 1 FROM neon_auth.account LIMIT 1;
-- Expected: ERROR: permission denied for table account
RESET ROLE;

-- (b) confirm an unscoped SELECT from public.projects under app_user with
--     no GUC set returns zero rows (default-deny via RLS)
SET ROLE app_user;
SELECT count(*) FROM public.projects;  -- expected: 0
RESET ROLE;

-- (c) confirm SECURITY DEFINER function is reachable from app_user
SET ROLE app_user;
SELECT * FROM public.lookup_team_invite_code('<nonexistent-code>');
-- Expected: zero rows, no error (function executes; just no match)
RESET ROLE;

-- (d) confirm auth_role has no grants on public
SET ROLE auth_role;
SELECT 1 FROM public.projects LIMIT 1;
-- Expected: ERROR: permission denied for table projects
RESET ROLE;

-- (e) Option B: confirm app_user is REVOKED from every neon_auth table.
--     Reads under app_user only succeed via the SECURITY DEFINER
--     public.current_user_* and public.team_*_visible functions.
SET ROLE app_user;
SELECT 1 FROM neon_auth."member" LIMIT 1;
-- Expected: ERROR: permission denied for table member
SELECT 1 FROM neon_auth."user" LIMIT 1;
-- Expected: ERROR: permission denied for table user
SELECT 1 FROM neon_auth."session" LIMIT 1;
-- Expected: ERROR: permission denied for table session
SELECT 1 FROM neon_auth.jwks LIMIT 1;
-- Expected: ERROR: permission denied for table jwks
RESET ROLE;

-- (f) confirm app_user CAN call the SECURITY DEFINER lookups
--     (the function bodies run as their owner, which retains SELECT).
SET ROLE app_user;
SELECT public.current_user_has_any_membership();
-- Expected: false (no GUC set; no caller identity → zero memberships)
SELECT public.current_user_org_ids();
-- Expected: {} (empty uuid array)
RESET ROLE;


-- -----------------------------------------------------------------------------
-- 8. REVOKE TEMPORARY on DATABASE from PUBLIC (CVE-2018-1058)
-- -----------------------------------------------------------------------------
-- Defense-in-depth alongside `pg_temp` pinned last in every SECURITY DEFINER
-- search_path. Removes the privilege that lets app_user create temp objects
-- which could shadow operators/functions used inside SDF bodies.
--
-- service_role and auth_role lose TEMPORARY too; nothing in our query path
-- creates temp tables (verified by inspection — drizzle's migration tracking
-- uses the permanent `drizzle.*` schema). Regrant explicitly if a future
-- feature needs it.
-- -----------------------------------------------------------------------------

REVOKE TEMPORARY ON DATABASE neondb FROM PUBLIC;

-- Verify (expected: false)
SELECT has_database_privilege('app_user', 'neondb', 'TEMPORARY') AS has_temp;
SELECT has_database_privilege('service_role', 'neondb', 'TEMPORARY') AS has_temp;
SELECT has_database_privilege('auth_role', 'neondb', 'TEMPORARY') AS has_temp;
