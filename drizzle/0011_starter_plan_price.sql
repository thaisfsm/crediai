-- Plano comercial Starter: R$ 150,00 por mês, guardado no campo que já existe (plan.price_in_cents, em centavos).
-- Só atualiza a linha do plano; não altera tenant, assinatura, usuário nem dado financeiro. Pode ser executada de novo.
-- A tabela plan tem RLS forçado e só aceita UPDATE no contexto SUPER_ADMIN; o set_config vale só nesta transação.
SELECT set_config('app.crediai_role', 'SUPER_ADMIN', true);--> statement-breakpoint
UPDATE "plan" SET "price_in_cents" = 15000, "description" = 'Plano Starter do CrediAI · R$ 150,00 por mês.', "updated_at" = now() WHERE "id" = 'plan_starter_v1';
