ALTER TABLE "activity_events" ADD COLUMN "note_id" uuid;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "shared_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_note_id_created_idx" ON "activity_events" USING btree ("note_id","created_at") WHERE note_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_note_ref_check" CHECK ("activity_events"."type" NOT LIKE 'note\_%' OR "activity_events"."note_id" IS NOT NULL);