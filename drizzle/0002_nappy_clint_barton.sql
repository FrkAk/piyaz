-- Defensive: collapse any pre-existing duplicate (task_id, text) rows before
-- adding the UNIQUE constraint. The JSONB-era write path already deduped by
-- id-OR-text, so this should be a no-op in practice. Keeps the row with the
-- LARGEST position (last writer wins, matching the legacy append-mode
-- "delete-then-insert" semantic).
DELETE FROM "task_acceptance_criteria" a
USING "task_acceptance_criteria" b
WHERE a."task_id" = b."task_id"
  AND a."text" = b."text"
  AND a."position" < b."position";
--> statement-breakpoint
DELETE FROM "task_decisions" a
USING "task_decisions" b
WHERE a."task_id" = b."task_id"
  AND a."text" = b."text"
  AND a."position" < b."position";
--> statement-breakpoint
ALTER TABLE "task_acceptance_criteria" ADD CONSTRAINT "task_acceptance_criteria_task_id_text_unique" UNIQUE("task_id","text");--> statement-breakpoint
ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_task_id_text_unique" UNIQUE("task_id","text");
