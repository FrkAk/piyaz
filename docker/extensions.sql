-- =============================================================================
-- Extensions every Piyaz database carries. Owner-only: CREATE EXTENSION needs
-- the database owner on Neon, never the least-privilege migration role, so
-- this is NOT a Drizzle migration. Applied by scripts/apply-owner-rls.ts
-- (db:rls:owner, hosted), the db:rls psql chain (self-host), and
-- tests/setup/migrate.ts (testcontainer). scripts/verify-rls.ts derives its
-- extension contract from this file, so a forgotten owner apply fails the
-- deploy. Idempotent.
--
-- pg_stat_statements: CREATE EXTENSION succeeds without preloading, but
-- collecting/querying stats requires shared_preload_libraries — set for Neon
-- by the platform and for self-host by the postgres command in
-- docker-compose.yml. The read path is scripts/db-stats.ts (owner-only).
--
-- Extensions live in their own schema, never public: the public schema is
-- owned by Drizzle, and `drizzle-kit push` (throwaway test DB) tries to drop
-- any non-Drizzle objects it finds there.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
