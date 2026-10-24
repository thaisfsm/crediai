ALTER TYPE "public"."user_role" ADD VALUE 'ACCOUNT_MANAGER';--> statement-breakpoint
CREATE TABLE "account_manager_payout" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"manager_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"paid_on" date NOT NULL,
	"notes" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_manager_payout_amount_positive" CHECK ("account_manager_payout"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "account_manager_payout" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "account_manager" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"user_id" text,
	"commission_bps" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_manager_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "account_manager_name_not_blank" CHECK (length(trim("account_manager"."name")) > 0),
	CONSTRAINT "account_manager_commission_range" CHECK ("account_manager"."commission_bps" >= 0 and "account_manager"."commission_bps" <= 10000)
);
--> statement-breakpoint
ALTER TABLE "account_manager" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "account_manager_id" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "account_manager_bps" integer;--> statement-breakpoint
ALTER TABLE "account_manager_payout" ADD CONSTRAINT "account_manager_payout_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_manager_payout" ADD CONSTRAINT "account_manager_payout_manager_same_tenant_fk" FOREIGN KEY ("tenant_id","manager_id") REFERENCES "public"."account_manager"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_manager" ADD CONSTRAINT "account_manager_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_manager" ADD CONSTRAINT "account_manager_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_manager_payout_manager_idx" ON "account_manager_payout" USING btree ("tenant_id","manager_id");--> statement-breakpoint
CREATE INDEX "account_manager_tenant_id_idx" ON "account_manager" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_manager_user_unique" ON "account_manager" USING btree ("user_id") WHERE "account_manager"."user_id" is not null;--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_account_manager_same_tenant_fk" FOREIGN KEY ("tenant_id","account_manager_id") REFERENCES "public"."account_manager"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_account_manager_idx" ON "client" USING btree ("tenant_id","account_manager_id");--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_account_manager_bps_valid" CHECK ("client"."account_manager_bps" is null or ("client"."account_manager_id" is not null and "client"."account_manager_bps" >= 0 and "client"."account_manager_bps" <= 10000));--> statement-breakpoint
CREATE POLICY "admin_audit_log_insert_tenant_managers" ON "admin_audit_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'TENANT_USER' and "admin_audit_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') and "admin_audit_log"."entity" in ('account_manager', 'account_manager_payout'));--> statement-breakpoint
CREATE POLICY "account_manager_payout_select_tenant_or_admin" ON "account_manager_payout" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_payout"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_payout_insert_own_or_admin" ON "account_manager_payout" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_payout"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_payout_update_own_or_admin" ON "account_manager_payout" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_payout"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_payout"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_payout_delete_admin_only" ON "account_manager_payout" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "account_manager_select_tenant_or_admin" ON "account_manager" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_insert_own_or_admin" ON "account_manager" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_update_own_or_admin" ON "account_manager" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_delete_admin_only" ON "account_manager" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
-- Comissão paga ao gerente: só se registra (não se edita nem se apaga). A exclusão em cascata do tenant continua possível.
CREATE OR REPLACE FUNCTION "crediai_manager_payout_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Pagamentos de comissão a gerentes confirmados não podem ser alterados nem apagados.' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "account_manager_payout_append_only" BEFORE UPDATE OR DELETE ON "account_manager_payout" FOR EACH ROW EXECUTE FUNCTION "crediai_manager_payout_append_only"();--> statement-breakpoint
CREATE TRIGGER "account_manager_payout_no_truncate" BEFORE TRUNCATE ON "account_manager_payout" FOR EACH STATEMENT EXECUTE FUNCTION "crediai_manager_payout_append_only"();
