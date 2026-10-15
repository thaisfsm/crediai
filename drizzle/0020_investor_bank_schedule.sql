-- Investidores: dados bancários e Pix do investidor; identificação, data do investimento, prazo, periodicidade e quantidade de
-- parcelas do contrato; cronograma de pagamentos ao investidor com valores digitados (investment_schedule_item) e histórico
-- de alterações visível ao tenant (investment_revision). Só acrescenta colunas vazias e tabelas novas; nada existente muda.
CREATE TABLE "investment_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"investment_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"changes" jsonb NOT NULL,
	"changed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_revision_kind_valid" CHECK ("investment_revision"."kind" in ('CONTRACT', 'SCHEDULE'))
);
--> statement-breakpoint
ALTER TABLE "investment_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "investment_schedule_item" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"investment_id" text NOT NULL,
	"number" integer NOT NULL,
	"due_date" date NOT NULL,
	"yield_cents" bigint DEFAULT 0 NOT NULL,
	"principal_cents" bigint DEFAULT 0 NOT NULL,
	"description" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_schedule_item_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "investment_schedule_item_number_positive" CHECK ("investment_schedule_item"."number" > 0),
	CONSTRAINT "investment_schedule_item_amounts_valid" CHECK ("investment_schedule_item"."yield_cents" >= 0 and "investment_schedule_item"."principal_cents" >= 0 and "investment_schedule_item"."yield_cents" + "investment_schedule_item"."principal_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "investment_schedule_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "contract_number" text;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "invested_on" date;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "term_months" integer;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "payment_frequency" text;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "installment_count" integer;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "bank_holder_name" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "bank_holder_document" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "bank_branch" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "bank_account" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "bank_account_type" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "pix_key_type" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "pix_key" text;--> statement-breakpoint
ALTER TABLE "investment_revision" ADD CONSTRAINT "investment_revision_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_revision" ADD CONSTRAINT "investment_revision_investment_same_tenant_fk" FOREIGN KEY ("tenant_id","investment_id") REFERENCES "public"."investment"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_schedule_item" ADD CONSTRAINT "investment_schedule_item_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_schedule_item" ADD CONSTRAINT "investment_schedule_item_investment_same_tenant_fk" FOREIGN KEY ("tenant_id","investment_id") REFERENCES "public"."investment"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investment_revision_investment_idx" ON "investment_revision" USING btree ("investment_id","created_at");--> statement-breakpoint
CREATE INDEX "investment_schedule_item_tenant_due_idx" ON "investment_schedule_item" USING btree ("tenant_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_schedule_item_number_unique" ON "investment_schedule_item" USING btree ("investment_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_tenant_contract_number_unique" ON "investment" USING btree ("tenant_id","contract_number") WHERE "investment"."contract_number" is not null;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_term_months_valid" CHECK ("investment"."term_months" is null or "investment"."term_months" between 1 and 600);--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_installment_count_valid" CHECK ("investment"."installment_count" is null or "investment"."installment_count" between 1 and 600);--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_payment_frequency_valid" CHECK ("investment"."payment_frequency" is null or "investment"."payment_frequency" in ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'YEARLY', 'AT_MATURITY', 'OTHER'));--> statement-breakpoint
ALTER TABLE "investor" ADD CONSTRAINT "investor_bank_account_type_valid" CHECK ("investor"."bank_account_type" is null or "investor"."bank_account_type" in ('CHECKING', 'SAVINGS', 'PAYMENT', 'SALARY'));--> statement-breakpoint
ALTER TABLE "investor" ADD CONSTRAINT "investor_pix_key_pair" CHECK (("investor"."pix_key" is null) = ("investor"."pix_key_type" is null) and ("investor"."pix_key_type" is null or "investor"."pix_key_type" in ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM')));--> statement-breakpoint
CREATE POLICY "investment_revision_select_tenant_or_admin" ON "investment_revision" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_revision"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_revision_insert_own_or_admin" ON "investment_revision" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_revision"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_revision_update_admin_only" ON "investment_revision" AS PERMISSIVE FOR UPDATE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN') WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "investment_revision_delete_admin_only" ON "investment_revision" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "investment_schedule_item_select_tenant_or_admin" ON "investment_schedule_item" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_schedule_item"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_schedule_item_insert_own_or_admin" ON "investment_schedule_item" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_schedule_item"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_schedule_item_update_own_or_admin" ON "investment_schedule_item" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_schedule_item"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_schedule_item"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_schedule_item_delete_own_or_admin" ON "investment_schedule_item" AS PERMISSIVE FOR DELETE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_schedule_item"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));