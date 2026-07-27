-- =============================================================================
-- Per-role runtime settings for the request-path roles. Requires ADMIN OPTION
-- on the target role, so it is applied by the superuser (self-host,
-- docker/init-rls.sh and the db:rls chain), by the database owner on the
-- hosted heads (scripts/apply-owner-rls.ts), and by the testcontainer
-- bootstrap (tests/setup/migrate.ts). The least-privilege CI migration role
-- cannot run it, so it is deliberately absent from scripts/apply-public-rls.ts
-- and does NOT land on a deploy. Idempotent: ALTER ROLE ... SET is
-- last-write-wins.
--
-- Out of scope here: role creation, grants, policies. No SUPERUSER clause,
-- which fails on Neon where toggling it needs a real superuser.
-- =============================================================================

-- Ceiling on how long one statement may run, matching STATEMENT_TIMEOUT_MS in
-- lib/db/_driver.node.ts and lib/db/_driver.workers.ts. Those set it as a
-- connection option, which the Neon HTTP transports drop: pool.query under
-- poolQueryViaFetch rebuilds a bare connection string, and the neon-http read
-- client behind withUserContextRead has no equivalent option at all. A role
-- default is carried by the session whatever the transport, so it is what
-- actually bounds the read path on the hosted head. Change the three together.
--
-- Only the two roles that serve requests. service_role is excluded because
-- drizzle.config.ts falls back to DATABASE_SERVICE_ROLE_URL for migrations, and
-- the hosted migration role is excluded for the same reason: a 15s ceiling
-- would abort an index build mid-deploy.
ALTER ROLE app_user SET statement_timeout = '15s';
ALTER ROLE auth_role SET statement_timeout = '15s';
