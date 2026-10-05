-- Promove UMA conta já existente a SUPER_ADMIN (MASTER), mantendo o tenant e a carteira dela.
-- NÃO EXECUTAR sem autorização. Pré-requisito: migração 0009_super_admin_role_guard aplicada.
-- Não altera tenant, assinatura, carteira, clientes, operações nem pagamentos: só a coluna "role" de uma linha de "user".
-- O e-mail serve só para localizar a conta nesta execução; a autorização no app continua vindo de "user".role.
--
-- Uso (psql com a URL de migração):
--   psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -v email='linkconsignados26@gmail.com' -f scripts/promote-master.sql
\set ON_ERROR_STOP on
BEGIN;

-- Libera a promoção só dentro desta transação (exigido pelo gatilho user_role_guard).
SELECT set_config('app.crediai_role_grant', 'promote', true), set_config('crediai.promote_email', :'email', true);

-- Antes: a conta precisa existir, estar ativa e ter tenant próprio (para manter a carteira).
SELECT id, email, role, tenant_id, active FROM "user" WHERE lower(email) = lower(:'email');

DO $$
DECLARE matched integer;
BEGIN
  SELECT count(*) INTO matched FROM "user"
   WHERE lower(email) = lower(current_setting('crediai.promote_email'))
     AND active AND tenant_id IS NOT NULL;
  IF matched <> 1 THEN
    RAISE EXCEPTION 'Esperava exatamente 1 conta ativa com tenant para este e-mail; encontrei %.', matched;
  END IF;
END $$;

UPDATE "user" SET role = 'SUPER_ADMIN', updated_at = now()
 WHERE lower(email) = lower(:'email') AND active AND tenant_id IS NOT NULL AND role = 'TENANT_USER';

-- Depois: role SUPER_ADMIN e o mesmo tenant_id de antes.
SELECT id, email, role, tenant_id, active FROM "user" WHERE lower(email) = lower(:'email');

COMMIT;
