-- Contrato de investimento gerado pelo sistema. Só estrutura nova: tabelas investment_contractor (empresa contratante,
-- uma por tenant) e investment_contract (versões do PDF gerado, ainda sem assinatura), ambas com RLS por tenant; endereço
-- opcional e vazio em investor; contract_id opcional e vazio em investment_document (a versão gerada que foi assinada) e
-- a política de INSERT da auditoria passa a aceitar também essas duas entidades. Nenhuma linha existente é alterada:
-- tenants, usuários, assinaturas, carteiras, clientes, operações, pagamentos, investimentos e documentos ficam como estão.
CREATE TABLE "investment_contractor" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"legal_name" text,
	"document" text,
	"address_cep" text,
	"address_street" text,
	"address_number" text,
	"address_complement" text,
	"address_district" text,
	"address_city" text,
	"address_state" text,
	"representative_name" text,
	"representative_document" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "investment_contractor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "investment_contractor" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "investment_contract" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"investment_id" text NOT NULL,
	"version" integer NOT NULL,
	"template_version" text NOT NULL,
	"data_hash" text NOT NULL,
	"includes_notes" boolean NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	"generated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_by_user_id" text,
	"superseded_at" timestamp with time zone,
	"superseded_by_contract_id" text,
	CONSTRAINT "investment_contract_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "investment_contract_version_positive" CHECK ("investment_contract"."version" > 0),
	CONSTRAINT "investment_contract_size_limit" CHECK ("investment_contract"."size_bytes" > 0 and "investment_contract"."size_bytes" <= 5242880),
	CONSTRAINT "investment_contract_superseded_link" CHECK (("investment_contract"."superseded_at" is null) = ("investment_contract"."superseded_by_contract_id" is null)),
	CONSTRAINT "investment_contract_sent_link" CHECK (("investment_contract"."sent_at" is null) = ("investment_contract"."sent_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "investment_contract" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "investment_contract" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "investment_document" ADD COLUMN "contract_id" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "address_cep" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "address_street" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "address_number" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "address_complement" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "address_district" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "address_city" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "address_state" text;--> statement-breakpoint
ALTER TABLE "investment_contractor" ADD CONSTRAINT "investment_contractor_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_contract" ADD CONSTRAINT "investment_contract_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_contract" ADD CONSTRAINT "investment_contract_investment_same_tenant_fk" FOREIGN KEY ("tenant_id","investment_id") REFERENCES "public"."investment"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investment_contract_investment_id_idx" ON "investment_contract" USING btree ("investment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_contract_version_unique" ON "investment_contract" USING btree ("investment_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_contract_current_unique" ON "investment_contract" USING btree ("investment_id") WHERE "investment_contract"."superseded_at" is null;--> statement-breakpoint
ALTER TABLE "investment_document" ADD CONSTRAINT "investment_document_contract_same_tenant_fk" FOREIGN KEY ("tenant_id","contract_id") REFERENCES "public"."investment_contract"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_document" ADD CONSTRAINT "investment_document_contract_only_signed" CHECK ("investment_document"."contract_id" is null or "investment_document"."kind" = 'SIGNED_CONTRACT');--> statement-breakpoint
CREATE POLICY "investment_contractor_select_tenant_or_admin" ON "investment_contractor" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_contractor"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_contractor_insert_own_or_admin" ON "investment_contractor" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_contractor"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_contractor_update_own_or_admin" ON "investment_contractor" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_contractor"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_contractor"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_contractor_delete_admin_only" ON "investment_contractor" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "investment_contract_select_tenant_or_admin" ON "investment_contract" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_contract"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_contract_insert_own_or_admin" ON "investment_contract" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_contract"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_contract_update_own_or_admin" ON "investment_contract" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_contract"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_contract"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_contract_delete_admin_only" ON "investment_contract" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
ALTER POLICY "admin_audit_log_insert_tenant_investors" ON "admin_audit_log" TO public WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'TENANT_USER' and "admin_audit_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') and "admin_audit_log"."entity" in ('investor', 'investment', 'investment_document', 'investment_contract', 'investment_contractor'));