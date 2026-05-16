#!/bin/bash
# Provision RLS-aware roles for self-hosted Postgres so a fresh clone
# exercises real RLS and matches Neon production parity. Idempotent —
# safe to re-run on existing databases.
#
# Three-role structure (mirrors Neon prod):
#   * mymir (Docker POSTGRES_USER, container superuser) — DB owner, used for
#     bootstrap and human admin via psql. Equivalent of Neon `neondb_owner`.
#     NOT used by the app at runtime.
#   * service_role — BYPASSRLS + CREATE on schema public, used by:
#       - `drizzle-kit push` migration runner (via DATABASE_SERVICE_ROLE_URL)
#       - the 4 documented bypass call sites (reserve/release/diagnose
#         invite-code, clearOrgMembershipArtifacts)
#   * app_user — NO BYPASSRLS, the runtime role for the Next.js app
#     (via DATABASE_URL). RLS policies fire on every query.
#
# Passwords flow in from docker-compose's environment block.
set -euo pipefail

: "${APP_USER_PASSWORD:?APP_USER_PASSWORD env var is required}"
: "${SERVICE_ROLE_PASSWORD:?SERVICE_ROLE_PASSWORD env var is required}"
: "${AUTH_ROLE_PASSWORD:?AUTH_ROLE_PASSWORD env var is required}"

for pw in "$APP_USER_PASSWORD" "$SERVICE_ROLE_PASSWORD" "$AUTH_ROLE_PASSWORD"; do
  case "$pw" in
    *\'*|*\"*|*\\*)
      echo "init-rls.sh: passwords must not contain quotes or backslashes" >&2
      exit 1
      ;;
  esac
done

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  <<EOSQL
-- NOBYPASSRLS is explicit on app_user/auth_role so a future ALTER ROLE
-- can be audited; without it, a silent BYPASSRLS flip would void RLS without
-- touching this file.
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'CREATE ROLE app_user LOGIN NOBYPASSRLS PASSWORD ''${APP_USER_PASSWORD}''';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'CREATE ROLE service_role LOGIN BYPASSRLS PASSWORD ''${SERVICE_ROLE_PASSWORD}''';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_role') THEN
    EXECUTE 'CREATE ROLE auth_role LOGIN NOBYPASSRLS PASSWORD ''${AUTH_ROLE_PASSWORD}''';
  END IF;
END \$\$;

-- Canonical schema/table/sequence grants live in docker/grants.sql so the
-- self-host, testcontainer, and Neon prod runbook stay in lockstep.
\i /opt/postgres-init/grants.sql

-- DB-level + drizzle migration schema (parameterized on POSTGRES_DB; kept
-- inline because the DB name varies per context).
GRANT CREATE ON DATABASE "${POSTGRES_DB}" TO service_role;
CREATE SCHEMA IF NOT EXISTS drizzle;
GRANT USAGE, CREATE ON SCHEMA drizzle TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

-- CVE-2018-1058 hardening: deny temp-object creation. Combined with
-- pg_temp pinned last in every SECURITY DEFINER's search_path
-- (docker/rls-functions.sql), this closes the operator/function
-- shadowing surface entirely. service_role and auth_role lose TEMPORARY
-- too; nothing in our query path creates temp tables. Regrant explicitly
-- if a future feature needs them.
REVOKE TEMPORARY ON DATABASE "${POSTGRES_DB}" FROM PUBLIC;
EOSQL
