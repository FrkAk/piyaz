-- Backfill note_feed_tasks from the legacy notes.feed_task_ids jsonb array.
-- The CASE guards the uuid cast (CASE is Postgres's only ordered-evaluation
-- construct; a WHERE or AND may be reordered before the cast), so a
-- malformed legacy id drops instead of aborting the migration. The JOIN
-- drops ids that reference no live task or a cross-project task;
-- ON CONFLICT keeps the migration re-runnable.
INSERT INTO note_feed_tasks (note_id, task_id)
SELECT n.id, t.id
FROM notes n
CROSS JOIN LATERAL jsonb_array_elements_text(n.feed_task_ids) AS fid(task_id)
JOIN tasks t
  ON t.id = CASE
      WHEN fid.task_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN fid.task_id::uuid
    END
  AND t.project_id = n.project_id
ON CONFLICT (note_id, task_id) DO NOTHING;
