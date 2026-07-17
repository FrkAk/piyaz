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
CREATE INDEX "note_feed_tasks_task_id_idx" ON "note_feed_tasks" USING btree ("task_id");