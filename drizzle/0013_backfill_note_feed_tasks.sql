-- Backfill note_feed_tasks from the legacy notes.feed_task_ids jsonb array.
-- The JOIN tasks filter drops ids that reference no live task or a
-- cross-project task; ON CONFLICT keeps the migration re-runnable.
INSERT INTO note_feed_tasks (note_id, task_id)
SELECT n.id, t.id
FROM notes n
CROSS JOIN LATERAL jsonb_array_elements_text(n.feed_task_ids) AS fid(task_id)
JOIN tasks t ON t.id = fid.task_id::uuid AND t.project_id = n.project_id
ON CONFLICT (note_id, task_id) DO NOTHING;
