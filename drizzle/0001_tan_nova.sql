CREATE TABLE IF NOT EXISTS "task_acceptance_criteria" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"text" text NOT NULL,
	"checked" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"decision_date" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"metadata" jsonb,
	CONSTRAINT "task_links_task_url_unique" UNIQUE("task_id","url")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_acceptance_criteria" ADD CONSTRAINT "task_acceptance_criteria_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_links" ADD CONSTRAINT "task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_links" ADD CONSTRAINT "task_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "neon_auth"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_acceptance_criteria_task_id_position_idx" ON "task_acceptance_criteria" USING btree ("task_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_decisions_task_id_position_idx" ON "task_decisions" USING btree ("task_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_links_task_id_idx" ON "task_links" USING btree ("task_id");--> statement-breakpoint
-- Backfill: task_acceptance_criteria from tasks.acceptance_criteria JSONB
INSERT INTO task_acceptance_criteria (id, task_id, text, checked, position, created_at, updated_at)
SELECT
  (elem->>'id')::uuid,
  t.id,
  elem->>'text',
  COALESCE((elem->>'checked')::boolean, false),
  (pos - 1)::integer,
  t.created_at,
  t.updated_at
FROM tasks t,
     jsonb_array_elements(t.acceptance_criteria) WITH ORDINALITY AS arr(elem, pos)
WHERE jsonb_array_length(t.acceptance_criteria) > 0
  AND (elem->>'id') IS NOT NULL
  AND (elem->>'text') IS NOT NULL;
--> statement-breakpoint
-- Backfill: task_decisions from tasks.decisions JSONB
INSERT INTO task_decisions (id, task_id, text, source, decision_date, position, created_at, updated_at)
SELECT
  (elem->>'id')::uuid,
  t.id,
  elem->>'text',
  COALESCE(elem->>'source', 'refinement'),
  COALESCE(elem->>'date', to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')),
  (pos - 1)::integer,
  t.created_at,
  t.updated_at
FROM tasks t,
     jsonb_array_elements(t.decisions) WITH ORDINALITY AS arr(elem, pos)
WHERE jsonb_array_length(t.decisions) > 0
  AND (elem->>'id') IS NOT NULL
  AND (elem->>'text') IS NOT NULL;
--> statement-breakpoint
-- Assertion: abort the migration if any criterion or decision was lost
DO $$
DECLARE
  src_criteria bigint;
  dst_criteria bigint;
  src_decisions bigint;
  dst_decisions bigint;
BEGIN
  SELECT COALESCE(SUM(jsonb_array_length(acceptance_criteria)), 0) INTO src_criteria
    FROM tasks WHERE jsonb_array_length(acceptance_criteria) > 0;
  SELECT COUNT(*) INTO dst_criteria FROM task_acceptance_criteria;

  SELECT COALESCE(SUM(jsonb_array_length(decisions)), 0) INTO src_decisions
    FROM tasks WHERE jsonb_array_length(decisions) > 0;
  SELECT COUNT(*) INTO dst_decisions FROM task_decisions;

  IF src_criteria != dst_criteria THEN
    RAISE EXCEPTION 'MYMR-136 backfill mismatch: acceptance_criteria src=% dst=%',
      src_criteria, dst_criteria;
  END IF;
  IF src_decisions != dst_decisions THEN
    RAISE EXCEPTION 'MYMR-136 backfill mismatch: decisions src=% dst=%',
      src_decisions, dst_decisions;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "acceptance_criteria";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "decisions";
