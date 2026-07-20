ALTER TABLE "projects" ADD COLUMN "meta_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "task_edges" ADD COLUMN "meta_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "meta_updated_at" timestamp with time zone DEFAULT now() NOT NULL;