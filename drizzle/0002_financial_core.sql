CREATE TYPE "public"."loan_operation_status" AS ENUM('OPEN', 'PAID', 'CANCELED');--> statement-breakpoint
CREATE TABLE "client" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"document" text,
	"phone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "client_name_not_blank" CHECK (length(trim("client"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "client" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "loan_operation" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"principal_cents" bigint NOT NULL,
	"interest_rate_bps" integer NOT NULL,
	"interest_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"loan_date" date NOT NULL,
	"due_date" date NOT NULL,
	"calculation_rule" text NOT NULL,
	"status" "loan_operation_status" DEFAULT 'OPEN' NOT NULL,
	"settled_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_operation_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "loan_operation_principal_positive" CHECK ("loan_operation"."principal_cents" > 0),
	CONSTRAINT "loan_operation_rate_non_negative" CHECK ("loan_operation"."interest_rate_bps" >= 0),
	CONSTRAINT "loan_operation_amounts_consistent" CHECK ("loan_operation"."interest_cents" >= 0 and "loan_operation"."total_cents" = "loan_operation"."principal_cents" + "loan_operation"."interest_cents"),
	CONSTRAINT "loan_operation_due_after_loan" CHECK ("loan_operation"."due_date" >= "loan_operation"."loan_date")
);
--> statement-breakpoint
ALTER TABLE "loan_operation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loan_operation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"paid_at" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_amount_positive" CHECK ("payment"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wallet" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"initial_capital_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_initial_capital_non_negative" CHECK ("wallet"."initial_capital_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "wallet" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD CONSTRAINT "loan_operation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD CONSTRAINT "loan_operation_client_same_tenant_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."client"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_operation_same_tenant_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."loan_operation"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_tenant_id_idx" ON "client" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "loan_operation_tenant_id_idx" ON "loan_operation" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "loan_operation_tenant_due_date_idx" ON "loan_operation" USING btree ("tenant_id","due_date");--> statement-breakpoint
CREATE INDEX "payment_tenant_id_idx" ON "payment" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "payment_operation_id_idx" ON "payment" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_tenant_id_unique" ON "wallet" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "client_select_tenant_or_admin" ON "client" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "client"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "client_insert_own_or_admin" ON "client" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "client"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "client_update_own_or_admin" ON "client" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "client"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "client"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "client_delete_admin_only" ON "client" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "loan_operation_select_tenant_or_admin" ON "loan_operation" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "loan_operation"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "loan_operation_insert_own_or_admin" ON "loan_operation" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "loan_operation"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "loan_operation_update_own_or_admin" ON "loan_operation" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "loan_operation"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "loan_operation"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "loan_operation_delete_admin_only" ON "loan_operation" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "payment_select_tenant_or_admin" ON "payment" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "payment"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "payment_insert_own_or_admin" ON "payment" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "payment"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "payment_update_own_or_admin" ON "payment" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "payment"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "payment"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "payment_delete_admin_only" ON "payment" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "wallet_select_tenant_or_admin" ON "wallet" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "wallet"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "wallet_insert_own_or_admin" ON "wallet" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "wallet"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "wallet_update_own_or_admin" ON "wallet" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "wallet"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "wallet"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "wallet_delete_admin_only" ON "wallet" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');