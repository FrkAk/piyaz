CREATE TABLE "note_feed_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_feed_tasks_note_task_unique" UNIQUE("note_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "note_feed_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "note_feed_tasks" ADD CONSTRAINT "note_feed_tasks_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_feed_tasks" ADD CONSTRAINT "note_feed_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_feed_tasks_task_id_idx" ON "note_feed_tasks" USING btree ("task_id");--> statement-breakpoint
-- Backfill note_feed_tasks from the legacy notes.feed_task_ids jsonb array.
-- The CASE guards the uuid cast (CASE is Postgres's only ordered-evaluation
-- construct; a WHERE or AND may be reordered before the cast), so a
-- malformed legacy id drops instead of aborting the migration. The JOIN
-- drops ids that reference no live task or a cross-project task;
-- ON CONFLICT keeps the statement re-runnable.
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