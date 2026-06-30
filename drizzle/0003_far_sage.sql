CREATE TABLE "note_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_note_id" uuid NOT NULL,
	"target_note_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_links_source_target_unique" UNIQUE("source_note_id","target_note_id"),
	CONSTRAINT "note_links_no_self" CHECK ("note_links"."source_note_id" <> "note_links"."target_note_id")
);
--> statement-breakpoint
ALTER TABLE "note_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "note_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_revisions_note_version_unique" UNIQUE("note_id","version")
);
--> statement-breakpoint
ALTER TABLE "note_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "note_task_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text DEFAULT 'mention' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_task_links_note_task_kind_unique" UNIQUE("note_id","task_id","kind"),
	CONSTRAINT "note_task_links_kind_check" CHECK ("note_task_links"."kind" IN ('mention', 'reference', 'spec_of'))
);
--> statement-breakpoint
ALTER TABLE "note_task_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"type" text DEFAULT 'reference' NOT NULL,
	"folder" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"agent_writable" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"feed_mode" text DEFAULT 'none' NOT NULL,
	"feed_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"feed_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"feed_task_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category" text,
	"version" integer DEFAULT 1 NOT NULL,
	"embedding_status" text DEFAULT 'none' NOT NULL,
	"pending_share_request" boolean DEFAULT false NOT NULL,
	"share_requested_by" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B')) STORED,
	CONSTRAINT "notes_visibility_check" CHECK ("notes"."visibility" IN ('private', 'team')),
	CONSTRAINT "notes_type_check" CHECK ("notes"."type" IN ('reference', 'guidance', 'knowledge')),
	CONSTRAINT "notes_feed_mode_check" CHECK ("notes"."feed_mode" IN ('none', 'all', 'categories', 'tags', 'tasks')),
	CONSTRAINT "notes_embedding_status_check" CHECK ("notes"."embedding_status" IN ('none', 'pending', 'ready', 'failed', 'stale'))
);
--> statement-breakpoint
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_source_note_id_notes_id_fk" FOREIGN KEY ("source_note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_target_note_id_notes_id_fk" FOREIGN KEY ("target_note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "piyaz_auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_task_links" ADD CONSTRAINT "note_task_links_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_task_links" ADD CONSTRAINT "note_task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_share_requested_by_user_id_fk" FOREIGN KEY ("share_requested_by") REFERENCES "piyaz_auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "piyaz_auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "piyaz_auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_links_target_idx" ON "note_links" USING btree ("target_note_id");--> statement-breakpoint
CREATE INDEX "note_task_links_task_id_idx" ON "note_task_links" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "notes_project_id_idx" ON "notes" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_project_slug_unique" ON "notes" USING btree ("project_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "notes_project_title_idx" ON "notes" USING btree ("project_id","title") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "notes_search_idx" ON "notes" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "notes_tags_idx" ON "notes" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "notes_feed_idx" ON "notes" USING btree ("project_id","feed_mode") WHERE feed_mode <> 'none';--> statement-breakpoint
CREATE INDEX "notes_embedding_status_idx" ON "notes" USING btree ("embedding_status") WHERE embedding_status IN ('pending','stale');--> statement-breakpoint
CREATE INDEX "notes_project_updated_idx" ON "notes" USING btree ("project_id","updated_at") WHERE deleted_at IS NULL;