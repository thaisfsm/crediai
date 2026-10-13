-- Módulo Financeiro. Só estrutura aditiva: o tipo OTHER_INCOME ("Outras entradas") no enum de movimentos de capital,
-- cinco colunas opcionais em capital_movement (categoria, descrição, quem lançou, origem e chave contra envio duplicado),
-- as regras que amarram categoria e tipo, um índice único parcial da chave e a política que deixa o usuário do tenant
-- registrar na auditoria os lançamentos do Financeiro e as mudanças do capital inicial (só no próprio tenant). Nenhuma linha existente é alterada: os
-- movimentos atuais ganham source = 'CAPITAL' pelo DEFAULT e ficam sem categoria, o que as novas regras aceitam.
-- Carteiras, operações, pagamentos, renovações, investimentos, contratos, tenants e usuários ficam como estão.
ALTER TYPE "public"."capital_movement_kind" ADD VALUE 'OTHER_INCOME';--> statement-breakpoint
ALTER TABLE "capital_movement" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "capital_movement" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "capital_movement" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "capital_movement" ADD COLUMN "source" text DEFAULT 'CAPITAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_movement" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "capital_movement_tenant_idempotency_unique" ON "capital_movement" USING btree ("tenant_id","idempotency_key") WHERE "capital_movement"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "capital_movement" ADD CONSTRAINT "capital_movement_source_valid" CHECK ("capital_movement"."source" in ('CAPITAL', 'FINANCE'));--> statement-breakpoint
ALTER TABLE "capital_movement" ADD CONSTRAINT "capital_movement_category_matches_kind" CHECK (("capital_movement"."category" is null and "capital_movement"."kind"::text <> 'OTHER_INCOME')
    or ("capital_movement"."kind"::text = 'CONTRIBUTION' and "capital_movement"."category" = 'CAPITAL_CONTRIBUTION')
    or ("capital_movement"."kind"::text = 'OTHER_INCOME' and "capital_movement"."category" = 'OTHER_INCOME')
    or ("capital_movement"."kind"::text = 'WITHDRAWAL' and "capital_movement"."category" in ('SALARY_WITHDRAWAL', 'PARTNER_WITHDRAWAL', 'OPERATING_EXPENSE', 'TAXES_AND_FEES', 'OTHER_OUTFLOW')));--> statement-breakpoint
ALTER TABLE "capital_movement" ADD CONSTRAINT "capital_movement_finance_fields" CHECK ("capital_movement"."source" <> 'FINANCE' or ("capital_movement"."category" is not null and length(trim(coalesce("capital_movement"."description", ''))) > 0 and "capital_movement"."idempotency_key" is not null));--> statement-breakpoint
CREATE POLICY "admin_audit_log_insert_tenant_finance" ON "admin_audit_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'TENANT_USER' and "admin_audit_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') and "admin_audit_log"."entity" in ('capital_movement', 'wallet'));