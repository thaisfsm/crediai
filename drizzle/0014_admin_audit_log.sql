-- Auditoria administrativa (Administração → Registros → Auditoria).
-- Só cria a tabela admin_audit_log, seus índices, políticas e o gatilho que a torna somente de inserção.
-- Não altera nenhuma tabela nem nenhuma linha existente: tenants, usuários, assinaturas, carteiras, clientes,
-- operações e pagamentos ficam intactos.
CREATE TABLE "admin_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"actor_email" text NOT NULL,
	"tenant_id" text,
	"tenant_name" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"description" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_log_tenant_idx" ON "admin_audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_log_action_idx" ON "admin_audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE POLICY "admin_audit_log_select_admin_only" ON "admin_audit_log" AS PERMISSIVE FOR SELECT TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "admin_audit_log_insert_admin_only" ON "admin_audit_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
-- Somente inserção, para qualquer papel de banco (inclusive o dono, que ignora RLS): UPDATE, DELETE e TRUNCATE falham.
CREATE OR REPLACE FUNCTION "crediai_admin_audit_log_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A auditoria administrativa não pode ser alterada nem apagada.' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "admin_audit_log_append_only" BEFORE UPDATE OR DELETE ON "admin_audit_log" FOR EACH ROW EXECUTE FUNCTION "crediai_admin_audit_log_append_only"();--> statement-breakpoint
CREATE TRIGGER "admin_audit_log_no_truncate" BEFORE TRUNCATE ON "admin_audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "crediai_admin_audit_log_append_only"();
