-- Módulo Investidores. Só estrutura nova: tabelas investor, investment e investment_document (com RLS por tenant),
-- quatro colunas opcionais e vazias em client (whatsapp, email, instagram, facebook) e uma política extra de INSERT na
-- auditoria para o usuário do tenant registrar as próprias ações de investidores. Nenhuma linha existente é alterada:
-- tenants, usuários, assinaturas, carteiras, clientes, operações, pagamentos e auditoria ficam como estão.
-- Nenhuma regra financeira de investimento é criada (sem rendimento, capitalização, resgate, multa ou renovação).
CREATE TYPE "public"."investment_document_kind" AS ENUM('SIGNED_CONTRACT', 'ADDENDUM', 'TRANSFER_RECEIPT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."investment_rate_period" AS ENUM('MONTHLY', 'YEARLY', 'CONTRACT_TERM', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."investment_status" AS ENUM('PENDING_SIGNATURE', 'ACTIVE', 'CLOSED', 'CANCELED');--> statement-breakpoint
CREATE TYPE "public"."investor_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TABLE "investment_document" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"investment_id" text NOT NULL,
	"kind" "investment_document_kind" NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"uploaded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaced_at" timestamp with time zone,
	"replaced_by_document_id" text,
	CONSTRAINT "investment_document_size_limit" CHECK ("investment_document"."size_bytes" > 0 and "investment_document"."size_bytes" <= 5242880),
	CONSTRAINT "investment_document_replaced_link" CHECK (("investment_document"."replaced_at" is null) = ("investment_document"."replaced_by_document_id" is null))
);
--> statement-breakpoint
ALTER TABLE "investment_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "investment_document" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "investment" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"investor_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"agreed_rate_bps" integer NOT NULL,
	"rate_period" "investment_rate_period" NOT NULL,
	"start_date" date NOT NULL,
	"maturity_date" date,
	"due_day" integer,
	"notes" text,
	"status" "investment_status" DEFAULT 'ACTIVE' NOT NULL,
	"calculation_rule" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "investment_amount_positive" CHECK ("investment"."amount_cents" > 0),
	CONSTRAINT "investment_rate_not_negative" CHECK ("investment"."agreed_rate_bps" >= 0),
	CONSTRAINT "investment_maturity_after_start" CHECK ("investment"."maturity_date" is null or "investment"."maturity_date" >= "investment"."start_date"),
	CONSTRAINT "investment_due_day_valid" CHECK ("investment"."due_day" is null or "investment"."due_day" between 1 and 31)
);
--> statement-breakpoint
ALTER TABLE "investment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "investment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "investor" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"document" text,
	"phone" text,
	"whatsapp" text,
	"email" text,
	"instagram" text,
	"facebook" text,
	"notes" text,
	"status" "investor_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investor_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "investor_name_not_blank" CHECK (length(trim("investor"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "investor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "investor" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "whatsapp" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "instagram" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "facebook" text;--> statement-breakpoint
ALTER TABLE "investment_document" ADD CONSTRAINT "investment_document_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_document" ADD CONSTRAINT "investment_document_investment_same_tenant_fk" FOREIGN KEY ("tenant_id","investment_id") REFERENCES "public"."investment"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_investor_same_tenant_fk" FOREIGN KEY ("tenant_id","investor_id") REFERENCES "public"."investor"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor" ADD CONSTRAINT "investor_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investment_document_investment_id_idx" ON "investment_document" USING btree ("investment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_document_current_contract_unique" ON "investment_document" USING btree ("investment_id") WHERE "investment_document"."kind" = 'SIGNED_CONTRACT' and "investment_document"."replaced_at" is null;--> statement-breakpoint
CREATE INDEX "investment_tenant_id_idx" ON "investment" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "investment_investor_id_idx" ON "investment" USING btree ("investor_id");--> statement-breakpoint
CREATE INDEX "investor_tenant_id_idx" ON "investor" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investor_tenant_document_unique" ON "investor" USING btree ("tenant_id","document") WHERE "investor"."document" is not null;--> statement-breakpoint
CREATE POLICY "admin_audit_log_insert_tenant_investors" ON "admin_audit_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'TENANT_USER' and "admin_audit_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') and "admin_audit_log"."entity" in ('investor', 'investment', 'investment_document'));--> statement-breakpoint
CREATE POLICY "investment_document_select_tenant_or_admin" ON "investment_document" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_document_insert_own_or_admin" ON "investment_document" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_document_update_own_or_admin" ON "investment_document" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_document_delete_admin_only" ON "investment_document" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "investment_select_tenant_or_admin" ON "investment" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_insert_own_or_admin" ON "investment" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_update_own_or_admin" ON "investment" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_delete_admin_only" ON "investment" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "investor_select_tenant_or_admin" ON "investor" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investor"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investor_insert_own_or_admin" ON "investor" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investor"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investor_update_own_or_admin" ON "investor" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investor"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investor"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investor_delete_admin_only" ON "investor" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');