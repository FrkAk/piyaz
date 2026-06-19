#!/bin/bash
# Provision RLS-aware roles for self-hosted Postgres. Idempotent.
#
# Roles:
#   * piyaz         — Docker superuser / DB owner. Not used by the app.
#   * service_role  — BYPASSRLS + CREATE on schema public. Migrations
#                     and the documented bypass sites (see lib/db/connection.ts).
#   * app_user      — NOBYPASSRLS runtime role. RLS fires on every query.
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
-- NOBYPASSRLS explicit so a silent BYPASSRLS flip on app_user/auth_role
-- is auditable against this file.
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

-- Re-assert on every bootstrap so a manual ALTER ROLE flip is reverted.
ALTER ROLE app_user NOBYPASSRLS NOSUPERUSER;
ALTER ROLE auth_role NOBYPASSRLS NOSUPERUSER;

-- Canonical grants are in docker/grants.sql (shared with the testcontainer).
\i /opt/postgres-init/grants.sql

-- DB name varies per context, so DB-level grants stay inline.
GRANT CREATE ON DATABASE "${POSTGRES_DB}" TO service_role;
CREATE SCHEMA IF NOT EXISTS drizzle;
GRANT USAGE, CREATE ON SCHEMA drizzle TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

-- CVE-2018-1058 hardening: deny temp-object creation. Combined with
-- pg_temp pinned last in every SECURITY DEFINER search_path, this closes
-- the operator/function shadowing surface.
-- KEEP IN SYNC WITH tests/setup/migrate.ts.
REVOKE TEMPORARY ON DATABASE "${POSTGRES_DB}" FROM PUBLIC;
EOSQL
