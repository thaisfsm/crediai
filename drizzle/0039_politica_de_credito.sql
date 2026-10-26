CREATE TABLE "credit_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"max_exposure_per_cpf_cents" bigint,
	"max_term_months" integer,
	"max_contract_cents" bigint,
	"min_rate_bps" integer,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_policy_values_valid" CHECK (("credit_policy"."max_exposure_per_cpf_cents" is null or "credit_policy"."max_exposure_per_cpf_cents" > 0) and ("credit_policy"."max_contract_cents" is null or "credit_policy"."max_contract_cents" > 0) and ("credit_policy"."max_term_months" is null or ("credit_policy"."max_term_months" >= 1 and "credit_policy"."max_term_months" <= 360)) and ("credit_policy"."min_rate_bps" is null or ("credit_policy"."min_rate_bps" >= 0 and "credit_policy"."min_rate_bps" <= 100000)))
);
--> statement-breakpoint
ALTER TABLE "credit_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_policy" ADD CONSTRAINT "credit_policy_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_policy_tenant_id_unique" ON "credit_policy" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "credit_policy_select_tenant_or_admin" ON "credit_policy" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_policy"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "credit_policy_insert_own_or_admin" ON "credit_policy" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_policy"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "credit_policy_update_own_or_admin" ON "credit_policy" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_policy"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "credit_policy"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "credit_policy_delete_admin_only" ON "credit_policy" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');