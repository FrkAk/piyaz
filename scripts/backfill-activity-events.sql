-- One-time backfill of activity_events from legacy tasks.history /
-- projects.history JSONB. Idempotent: skips any task/project that already has
-- an event row. Identity is unknown in legacy data (actor columns null);
-- source is inferred from the old binary `actor`. Run once with migration
-- credentials (never the runtime app_user / serviceRoleDb path):
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
  CASE elem->>'actor' WHEN 'ai' THEN 'mcp' ELSE 'web' END,
  NULL,
  COALESCE(elem->>'label', ''),
  NULL,
  NULL
FROM tasks t
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(t.history) = 'array' THEN t.history ELSE '[]'::jsonb END
) AS elem
WHERE NOT EXISTS (SELECT 1 FROM activity_events e WHERE e.task_id = t.id);

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
  CASE elem->>'actor' WHEN 'ai' THEN 'mcp' ELSE 'web' END,
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
  );
