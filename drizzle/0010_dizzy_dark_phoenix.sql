ALTER TABLE "notes" ADD COLUMN "meta_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "notes" SET "meta_updated_at" = "updated_at";