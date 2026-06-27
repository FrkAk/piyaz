CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"source" text NOT NULL,
	"actor_client_id" text,
	"summary" text NOT NULL,
	"target_ref" text,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "activity_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "piyaz_auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_task_id_created_idx" ON "activity_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_events_project_id_created_idx" ON "activity_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_events_actor_user_id_idx" ON "activity_events" USING btree ("actor_user_id");