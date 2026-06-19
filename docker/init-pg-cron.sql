-- Nightly purge of expired and revoked OAuth tokens.
-- Apply against the application database. pg_cron schedules in UTC.
-- Idempotent — safe to re-run.

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  PERFORM cron.unschedule('purge-oauth-tokens')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-oauth-tokens');
END $$;

SELECT cron.schedule(
  'purge-oauth-tokens',
  '0 3 * * *',
  $$
  DELETE FROM piyaz_auth."oauthRefreshToken"
   WHERE revoked IS NOT NULL OR "expiresAt" < now();
  DELETE FROM piyaz_auth."oauthAccessToken"
   WHERE "expiresAt" < now();
  $$
);
