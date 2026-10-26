CREATE TABLE "credit_proposal_review" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"phase" text NOT NULL,
	"checks" jsonb NOT NULL,
	"note" text,
	"completed" boolean DEFAULT false NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_proposal_review_phase_valid" CHECK ("credit_proposal_review"."phase" in ('IDENTITY','DOCUMENTS','CAPACITY','ENGINE','APPROVAL','ACCEPTANCE'))
);
--> statement-breakpoint
ALTER TABLE "credit_proposal_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_proposal_review" ADD CONSTRAINT "credit_proposal_review_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_proposal_review" ADD CONSTRAINT "credit_proposal_review_proposal_id_credit_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."credit_proposal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_proposal_review_phase_unique" ON "credit_proposal_review" USING btree ("proposal_id","phase");--> statement-breakpoint
CREATE POLICY "credit_proposal_review_select_tenant_or_admin" ON "credit_proposal_review" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal_review"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "credit_proposal_review_insert_own_or_admin" ON "credit_proposal_review" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal_review"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "credit_proposal_review_update_own_or_admin" ON "credit_proposal_review" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal_review"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal_review"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "credit_proposal_review_delete_own_or_admin" ON "credit_proposal_review" AS PERMISSIVE FOR DELETE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_proposal_review"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));