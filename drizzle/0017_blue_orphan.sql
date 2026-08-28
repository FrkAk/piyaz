CREATE TABLE "organization_export_limits" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_export_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_export_limits" ADD CONSTRAINT "organization_export_limits_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "piyaz_auth"."user"("id") ON DELETE cascade ON UPDATE no action;