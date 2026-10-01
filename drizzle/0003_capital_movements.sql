CREATE TYPE "public"."capital_movement_kind" AS ENUM('CONTRIBUTION');--> statement-breakpoint
CREATE TABLE "capital_movement" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" "capital_movement_kind" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"occurred_at" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capital_movement_amount_positive" CHECK ("capital_movement"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "capital_movement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "capital_movement" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "capital_movement" ADD CONSTRAINT "capital_movement_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capital_movement_tenant_id_idx" ON "capital_movement" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "capital_movement_select_tenant_or_admin" ON "capital_movement" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "capital_movement"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "capital_movement_insert_own_or_admin" ON "capital_movement" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "capital_movement"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "capital_movement_update_own_or_admin" ON "capital_movement" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "capital_movement"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "capital_movement"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "capital_movement_delete_admin_only" ON "capital_movement" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');