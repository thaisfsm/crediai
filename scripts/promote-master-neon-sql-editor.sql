-- ============================================================================
-- VERSÃO PARA O SQL EDITOR DO NEON (colar e executar inteiro; não usa psql).
-- Promove a conta linkconsignados26@gmail.com a SUPER_ADMIN (MASTER), mantendo o tenant e a carteira dela.
-- NÃO EXECUTAR sem autorização. Pré-requisito recomendado: migração 0009_super_admin_role_guard aplicada.
--
-- Tudo roda numa única transação. Altera somente "role" e "updated_at" de UMA linha de "user".
-- Não altera tenant, carteira, assinatura, clientes, operações, pagamentos nem nenhum dado financeiro.
-- Se não houver exatamente 1 conta ativa com tenant para o e-mail, ou se o tenant mudar, nada é gravado.
-- O e-mail serve só para localizar a conta nesta execução; a autorização no app continua vindo de "user".role.
-- Versão para psql (linha de comando): scripts/promote-master.sql
-- ============================================================================
BEGIN;

DO $$
DECLARE
  target_email constant text := 'linkconsignados26@gmail.com';
  matched integer;
  target_id text;
  tenant_before text;
  tenant_after text;
  role_after text;
  changed integer;
BEGIN
  -- Libera a promoção só dentro desta transação (exigido pelo gatilho user_role_guard da migração 0009).
  PERFORM set_config('app.crediai_role_grant', 'promote', true);

  SELECT count(*) INTO matched FROM "user"
   WHERE lower(email) = lower(target_email) AND active AND tenant_id IS NOT NULL;
  IF matched <> 1 THEN
    RAISE EXCEPTION 'Esperava exatamente 1 conta ativa com tenant para %; encontrei %. Nada foi alterado.', target_email, matched;
  END IF;

  SELECT id, tenant_id INTO target_id, tenant_before FROM "user"
   WHERE lower(email) = lower(target_email) AND active AND tenant_id IS NOT NULL;

  UPDATE "user" SET role = 'SUPER_ADMIN', updated_at = now()
   WHERE id = target_id AND role = 'TENANT_USER';
  GET DIAGNOSTICS changed = ROW_COUNT;

  SELECT role::text, tenant_id INTO role_after, tenant_after FROM "user" WHERE id = target_id;
  IF role_after <> 'SUPER_ADMIN' OR tenant_after IS DISTINCT FROM tenant_before THEN
    RAISE EXCEPTION 'Conferência falhou (role %, tenant % -> %). Nada foi alterado.', role_after, tenant_before, tenant_after;
  END IF;

  RAISE NOTICE 'Conta % agora é SUPER_ADMIN (linhas alteradas: %; 0 = já era SUPER_ADMIN). Tenant mantido: %.', target_email, changed, tenant_after;
END $$;

-- Resultado: role SUPER_ADMIN e o mesmo tenant_id de antes.
SELECT id, email, role, tenant_id, active, updated_at FROM "user" WHERE lower(email) = lower('linkconsignados26@gmail.com');

COMMIT;
