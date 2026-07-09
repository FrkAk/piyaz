CREATE TABLE "note_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"path" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "note_folders" ADD CONSTRAINT "note_folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_folders" ADD CONSTRAINT "note_folders_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "piyaz_auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "note_folders_project_path_unique" ON "note_folders" USING btree ("project_id","path");