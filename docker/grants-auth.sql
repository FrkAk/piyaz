-- =============================================================================
-- piyaz_auth GRANT/REVOKE for the auth_role / service_role split. Owner-only:
-- these touch the piyaz_auth schema, so they must be applied by the database
-- owner — never the least-privilege migration role. Consumed by
-- docker/init-rls.sh (self-host bootstrap), tests/setup/migrate.ts
-- (testcontainer), and scripts/apply-owner-rls.ts (db:rls:owner). Idempotent.
--
-- The public-schema grants live in docker/grants.sql.
-- =============================================================================

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

-- migrator: USAGE + REFERENCES so it can create the public→piyaz_auth foreign
-- keys during migration. REFERENCES grants FK creation only, not SELECT, so the
-- migration role still cannot read auth rows. Guarded because self-host and the
-- testcontainer have no migrator role. New auth tables referenced by a public
-- FK add their REFERENCES here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA piyaz_auth TO migrator';
    EXECUTE 'GRANT REFERENCES ON piyaz_auth."user" TO migrator';
    EXECUTE 'GRANT REFERENCES ON piyaz_auth.organization TO migrator';
  END IF;
END $$;
