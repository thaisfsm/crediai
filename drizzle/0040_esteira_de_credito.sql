CREATE TABLE "credit_proposal" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"applicant_name" text NOT NULL,
	"cpf" text NOT NULL,
	"email" text,
	"phone" text,
	"requested_cents" bigint NOT NULL,
	"term_months" integer NOT NULL,
	"phase" text DEFAULT 'RECEIVED' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"decision_note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phase_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_proposal_phase_valid" CHECK ("credit_proposal"."phase" in ('RECEIVED','IDENTITY','DOCUMENTS','CAPACITY','ENGINE','APPROVAL','ACCEPTANCE')),
	CONSTRAINT "credit_proposal_status_valid" CHECK ("credit_proposal"."status" in ('OPEN','REJECTED')),
	CONSTRAINT "credit_proposal_values_valid" CHECK ("credit_proposal"."requested_cents" > 0 and "credit_proposal"."term_months" >= 1 and "credit_proposal"."term_months" <= 360)
);
--> statement-breakpoint
ALTER TABLE "credit_proposal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD CONSTRAINT "credit_proposal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_proposal_tenant_phase_idx" ON "credit_proposal" USING btree ("tenant_id","phase");--> statement-breakpoint
CREATE POLICY "credit_proposal_select_tenant_or_admin" ON "credit_proposal" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "credit_proposal_insert_own_or_admin" ON "credit_proposal" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "credit_proposal_update_own_or_admin" ON "credit_proposal" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "credit_proposal_delete_admin_only" ON "credit_proposal" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');