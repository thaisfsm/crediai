CREATE TABLE "installment_deferral" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"original_number" integer NOT NULL,
	"original_due_date" date NOT NULL,
	"original_amount_cents" bigint NOT NULL,
	"addition_cents" bigint DEFAULT 0 NOT NULL,
	"new_due_date" date NOT NULL,
	"new_amount_cents" bigint NOT NULL,
	"reason" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installment_deferral_valid" CHECK ("installment_deferral"."original_number" >= 1 and "installment_deferral"."original_amount_cents" > 0 and "installment_deferral"."addition_cents" >= 0 and "installment_deferral"."new_amount_cents" = "installment_deferral"."original_amount_cents" + "installment_deferral"."addition_cents" and "installment_deferral"."new_due_date" > "installment_deferral"."original_due_date")
);
--> statement-breakpoint
ALTER TABLE "installment_deferral" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "installment_deferral" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "installment_deferral" ADD CONSTRAINT "installment_deferral_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment_deferral" ADD CONSTRAINT "installment_deferral_operation_same_tenant_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."loan_operation"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installment_deferral_operation_id_idx" ON "installment_deferral" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installment_deferral_operation_number_unique" ON "installment_deferral" USING btree ("operation_id","original_number");--> statement-breakpoint
CREATE POLICY "installment_deferral_select_tenant_or_admin" ON "installment_deferral" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "installment_deferral"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "installment_deferral_insert_own_or_admin" ON "installment_deferral" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "installment_deferral"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "installment_deferral_update_own_or_admin" ON "installment_deferral" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "installment_deferral"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "installment_deferral"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "installment_deferral_delete_admin_only" ON "installment_deferral" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');