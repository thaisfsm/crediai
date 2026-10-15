-- Correção de operação sem pagamentos (Etapa G, parte 1): histórico das correções (loan_operation_revision) e a permissão
-- do usuário do tenant registrar na auditoria as correções da própria carteira. Só acrescenta; nada existente muda.
CREATE TABLE "loan_operation_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"reason" text NOT NULL,
	"changes" jsonb NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"edited_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_operation_revision_reason_not_blank" CHECK (length(trim("loan_operation_revision"."reason")) >= 3)
);
--> statement-breakpoint
ALTER TABLE "loan_operation_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loan_operation_revision" ADD CONSTRAINT "loan_operation_revision_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_operation_revision" ADD CONSTRAINT "loan_operation_revision_operation_same_tenant_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."loan_operation"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loan_operation_revision_operation_idx" ON "loan_operation_revision" USING btree ("operation_id","created_at");--> statement-breakpoint
CREATE POLICY "admin_audit_log_insert_tenant_operations" ON "admin_audit_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'TENANT_USER' and "admin_audit_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') and "admin_audit_log"."entity" = 'loan_operation');--> statement-breakpoint
CREATE POLICY "loan_operation_revision_select_tenant_or_admin" ON "loan_operation_revision" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "loan_operation_revision"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "loan_operation_revision_insert_own_or_admin" ON "loan_operation_revision" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "loan_operation_revision"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "loan_operation_revision_update_admin_only" ON "loan_operation_revision" AS PERMISSIVE FOR UPDATE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN') WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "loan_operation_revision_delete_admin_only" ON "loan_operation_revision" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');