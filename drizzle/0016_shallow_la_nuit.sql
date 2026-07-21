ALTER TABLE "notes" ALTER COLUMN "updated_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "meta_updated_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "updated_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "meta_updated_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "task_edges" ALTER COLUMN "updated_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "task_edges" ALTER COLUMN "meta_updated_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "updated_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "meta_updated_at" SET DEFAULT clock_timestamp();