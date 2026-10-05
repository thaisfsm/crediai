-- Clientes SaaS: telefone de contato do tenant, troca obrigatória da senha provisória e último acesso.
-- Só acrescenta colunas (com valor padrão ou vazias); não altera nenhuma linha existente.
ALTER TABLE "tenant" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_login_at" timestamp with time zone;