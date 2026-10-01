CREATE TABLE "wallet_cycle" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"cycle_number" integer NOT NULL,
	"initial_capital_cents" bigint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by_user_id" text,
	CONSTRAINT "wallet_cycle_cycle_number_positive" CHECK ("wallet_cycle"."cycle_number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "wallet_cycle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet_cycle" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "capital_movement" ADD COLUMN "cycle_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD COLUMN "cycle_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet" ADD COLUMN "cycle_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet" ADD COLUMN "cycle_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallet_cycle" ADD CONSTRAINT "wallet_cycle_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_cycle_tenant_number_unique" ON "wallet_cycle" USING btree ("tenant_id","cycle_number");--> statement-breakpoint
CREATE INDEX "capital_movement_tenant_cycle_idx" ON "capital_movement" USING btree ("tenant_id","cycle_number");--> statement-breakpoint
CREATE INDEX "loan_operation_tenant_cycle_idx" ON "loan_operation" USING btree ("tenant_id","cycle_number");--> statement-breakpoint
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_cycle_number_positive" CHECK ("wallet"."cycle_number" >= 1);--> statement-breakpoint
CREATE POLICY "wallet_cycle_select_tenant_or_admin" ON "wallet_cycle" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "wallet_cycle"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "wallet_cycle_insert_own_or_admin" ON "wallet_cycle" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "wallet_cycle"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "wallet_cycle_update_own_or_admin" ON "wallet_cycle" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "wallet_cycle"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "wallet_cycle"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "wallet_cycle_delete_admin_only" ON "wallet_cycle" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');