-- Modelo comercial: plano (produto e preço padrão) x assinatura (condição comercial de cada cliente SaaS).
-- Só cria tipos, a tabela subscription_charge (mensalidades) e colunas novas, todas vazias ou com valor padrão.
-- Não apaga nada e não altera nenhum valor existente: tenants, usuários, carteiras, clientes, operações e pagamentos
-- ficam intactos, e as assinaturas atuais continuam com o mesmo status, plano e vencimento.
-- As políticas de INSERT/UPDATE da assinatura passam a aceitar só o contexto SUPER_ADMIN (o tenant apenas lê).
CREATE TYPE "public"."billing_cycle" AS ENUM('MONTHLY');--> statement-breakpoint
CREATE TYPE "public"."commercial_condition" AS ENUM('STANDARD', 'CUSTOM', 'COURTESY');--> statement-breakpoint
CREATE TYPE "public"."subscription_charge_status" AS ENUM('PENDING', 'PAID', 'CANCELED', 'FAILED');--> statement-breakpoint
CREATE TABLE "subscription_charge" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"due_date" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "subscription_charge_status" DEFAULT 'PENDING' NOT NULL,
	"paid_at" date,
	"provider" text DEFAULT 'MANUAL' NOT NULL,
	"provider_reference" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_charge_amount_check" CHECK ("subscription_charge"."amount_cents" >= 0),
	CONSTRAINT "subscription_charge_paid_check" CHECK (("subscription_charge"."status" = 'PAID') = ("subscription_charge"."paid_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "subscription_charge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_charge" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "features" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "contracted_price_cents" integer;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "commercial_condition" "commercial_condition";--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "activated_at" date;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "first_due_date" date;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "next_due_date" date;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "billing_cycle" "billing_cycle" DEFAULT 'MONTHLY' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "grace_days" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_charge" ADD CONSTRAINT "subscription_charge_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_charge" ADD CONSTRAINT "subscription_charge_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_charge_subscription_idx" ON "subscription_charge" USING btree ("subscription_id","due_date");--> statement-breakpoint
CREATE INDEX "subscription_charge_tenant_idx" ON "subscription_charge" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_contracted_price_check" CHECK ("subscription"."contracted_price_cents" is null or "subscription"."contracted_price_cents" >= 0);--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_courtesy_free_check" CHECK ("subscription"."commercial_condition" is distinct from 'COURTESY' or "subscription"."contracted_price_cents" = 0);--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_grace_days_check" CHECK ("subscription"."grace_days" between 0 and 60);--> statement-breakpoint
CREATE POLICY "subscription_charge_select_tenant_or_admin" ON "subscription_charge" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "subscription_charge"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "subscription_charge_insert_admin_only" ON "subscription_charge" AS PERMISSIVE FOR INSERT TO public WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "subscription_charge_update_admin_only" ON "subscription_charge" AS PERMISSIVE FOR UPDATE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN') WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "subscription_charge_delete_admin_only" ON "subscription_charge" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
ALTER POLICY "subscription_insert_own_or_admin" ON "subscription" TO public WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
ALTER POLICY "subscription_update_own_or_admin" ON "subscription" TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN') WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');