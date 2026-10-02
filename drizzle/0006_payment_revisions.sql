CREATE TABLE "payment_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"previous_amount_cents" bigint NOT NULL,
	"previous_paid_at" date NOT NULL,
	"previous_notes" text,
	"amount_cents" bigint NOT NULL,
	"paid_at" date NOT NULL,
	"notes" text,
	"edited_by_user_id" text,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_revision_amounts_positive" CHECK ("payment_revision"."previous_amount_cents" > 0 and "payment_revision"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_revision" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_revision" ADD CONSTRAINT "payment_revision_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_tenant_id_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "payment_revision" ADD CONSTRAINT "payment_revision_payment_same_tenant_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payment"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_revision_payment_id_idx" ON "payment_revision" USING btree ("payment_id");--> statement-breakpoint
CREATE POLICY "payment_revision_select_tenant_or_admin" ON "payment_revision" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "payment_revision"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "payment_revision_insert_own_or_admin" ON "payment_revision" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "payment_revision"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "payment_revision_update_own_or_admin" ON "payment_revision" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "payment_revision"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "payment_revision"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "payment_revision_delete_admin_only" ON "payment_revision" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');