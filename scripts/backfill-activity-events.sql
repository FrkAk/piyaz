-- One-time backfill of activity_events from legacy tasks.history /
-- projects.history JSONB. Identity is unknown in legacy data: the old code
-- stamped actor:"ai" on every entry (even human web actions), so the real
-- actor cannot be recovered. Every backfilled row is therefore attributed to
-- source='system' with null actor columns rather than fabricating web/agent.
--
-- Safe to run at any point relative to the deploy and re-runnable: dedup is
-- per legacy entry scoped to system-sourced rows, so a task already carrying
-- runtime events still gets its legacy history migrated, and a second run
-- inserts nothing. Run once with migration credentials (never the runtime
-- app_user / serviceRoleDb path):
--   psql "$DATABASE_SERVICE_ROLE_URL" -f scripts/backfill-activity-events.sql

INSERT INTO activity_events
  (project_id, task_id, type, created_at, actor_user_id, source,
   actor_client_id, summary, target_ref, metadata)
SELECT
  t.project_id,
  t.id,
  CASE elem->>'type'
    WHEN 'created'       THEN 'task_created'
    WHEN 'status_change' THEN 'status_changed'
    WHEN 'planned'       THEN 'plan_set'
    WHEN 'decision'      THEN 'decision_added'
    WHEN 'edge_added'    THEN 'edge_added'
    WHEN 'edge_removed'  THEN 'edge_removed'
    WHEN 'edge_updated'  THEN 'edge_updated'
    WHEN 'moved'         THEN 'moved'
    ELSE 'description_changed'
  END,
  (elem->>'date')::timestamptz,
  NULL,
  'system',
  NULL,
  COALESCE(elem->>'label', ''),
  NULL,
  NULL
FROM tasks t
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(t.history) = 'array' THEN t.history ELSE '[]'::jsonb END
) AS elem
WHERE NOT EXISTS (
    SELECT 1 FROM activity_events e
    WHERE e.task_id = t.id
      AND e.source = 'system'
      AND e.created_at = (elem->>'date')::timestamptz
      AND e.summary = COALESCE(elem->>'label', '')
  );

INSERT INTO activity_events
  (project_id, task_id, type, created_at, actor_user_id, source,
   actor_client_id, summary, target_ref, metadata)
SELECT
  p.id,
  NULL,
  CASE elem->>'type'
    WHEN 'created' THEN 'project_created'
    ELSE 'description_changed'
  END,
  (elem->>'date')::timestamptz,
  NULL,
  'system',
  NULL,
  COALESCE(elem->>'label', ''),
  NULL,
  NULL
FROM projects p
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(p.history) = 'array' THEN p.history ELSE '[]'::jsonb END
) AS elem
WHERE NOT EXISTS (
    SELECT 1 FROM activity_events e
    WHERE e.project_id = p.id AND e.task_id IS NULL
      AND e.source = 'system'
      AND e.created_at = (elem->>'date')::timestamptz
      AND e.summary = COALESCE(elem->>'label', '')
  );
