CREATE TABLE "legal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"document_type" text NOT NULL,
	"document_version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "legal_acceptances_document_type_check" CHECK ("legal_acceptances"."document_type" IN ('terms', 'privacy', 'dpa')),
	CONSTRAINT "legal_acceptances_ip_len_check" CHECK (char_length("legal_acceptances"."ip_address") <= 64),
	CONSTRAINT "legal_acceptances_user_agent_len_check" CHECK (char_length("legal_acceptances"."user_agent") <= 1024)
);
--> statement-breakpoint
ALTER TABLE "legal_acceptances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "piyaz_auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "piyaz_auth"."organization"("id") ON DELETE set null ON UPDATE no action;