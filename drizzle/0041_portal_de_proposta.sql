CREATE TABLE "credit_proposal_document" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_proposal_document_kind_valid" CHECK ("credit_proposal_document"."kind" in ('ID_DOCUMENT','PROOF_OF_ADDRESS','BANK_STATEMENT','PAYSLIP')),
	CONSTRAINT "credit_proposal_document_size_limit" CHECK ("credit_proposal_document"."size_bytes" > 0 and "credit_proposal_document"."size_bytes" <= 4194304)
);
--> statement-breakpoint
ALTER TABLE "credit_proposal_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "proposal_applicant_session" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"applicant_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposal_applicant_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "proposal_applicant" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposal_applicant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "proposal_link" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"token" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposal_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_proposal" DROP CONSTRAINT "credit_proposal_status_valid";--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "source" text DEFAULT 'OWNER' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "applicant_id" text;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "monthly_income_cents" bigint;--> statement-breakpoint
ALTER TABLE "credit_proposal_document" ADD CONSTRAINT "credit_proposal_document_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_proposal_document" ADD CONSTRAINT "credit_proposal_document_proposal_id_credit_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."credit_proposal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_applicant_session" ADD CONSTRAINT "proposal_applicant_session_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_applicant_session" ADD CONSTRAINT "proposal_applicant_session_applicant_id_proposal_applicant_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."proposal_applicant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_applicant" ADD CONSTRAINT "proposal_applicant_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_link" ADD CONSTRAINT "proposal_link_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_proposal_document_kind_unique" ON "credit_proposal_document" USING btree ("proposal_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_applicant_session_token_unique" ON "proposal_applicant_session" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_applicant_tenant_email_unique" ON "proposal_applicant" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_link_tenant_unique" ON "proposal_link" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_link_token_unique" ON "proposal_link" USING btree ("token");--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD CONSTRAINT "credit_proposal_source_valid" CHECK ("credit_proposal"."source" in ('OWNER','APPLICANT'));--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD CONSTRAINT "credit_proposal_status_valid" CHECK ("credit_proposal"."status" in ('DRAFT','OPEN','REJECTED'));--> statement-breakpoint
CREATE POLICY "credit_proposal_document_select_tenant_or_admin" ON "credit_proposal_document" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "credit_proposal_document_insert_own_or_admin" ON "credit_proposal_document" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "credit_proposal_document_update_own_or_admin" ON "credit_proposal_document" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "credit_proposal_document_delete_own_or_admin" ON "credit_proposal_document" AS PERMISSIVE FOR DELETE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "proposal_applicant_session_select_tenant_or_admin" ON "proposal_applicant_session" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_applicant_session"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "proposal_applicant_session_insert_own_or_admin" ON "proposal_applicant_session" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_applicant_session"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "proposal_applicant_session_update_own_or_admin" ON "proposal_applicant_session" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_applicant_session"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_applicant_session"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "proposal_applicant_session_delete_own_or_admin" ON "proposal_applicant_session" AS PERMISSIVE FOR DELETE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_applicant_session"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "proposal_applicant_select_tenant_or_admin" ON "proposal_applicant" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_applicant"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "proposal_applicant_insert_own_or_admin" ON "proposal_applicant" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_applicant"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "proposal_applicant_update_own_or_admin" ON "proposal_applicant" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_applicant"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_applicant"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "proposal_applicant_delete_admin_only" ON "proposal_applicant" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "proposal_link_select_tenant_or_admin" ON "proposal_link" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_link"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "proposal_link_insert_own_or_admin" ON "proposal_link" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_link"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "proposal_link_update_own_or_admin" ON "proposal_link" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_link"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "proposal_link"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "proposal_link_delete_admin_only" ON "proposal_link" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');