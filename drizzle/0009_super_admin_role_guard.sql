-- Proteção no banco para o papel SUPER_ADMIN (MASTER).
-- Nenhum INSERT pode criar SUPER_ADMIN e nenhum UPDATE pode promover alguém a SUPER_ADMIN,
-- a menos que a própria transação declare o procedimento administrativo com
--   select set_config('app.crediai_role_grant', 'promote', true);
-- O cadastro público (Better Auth) nunca define essa configuração, então todo novo cadastro fica TENANT_USER.
-- Esta migração não altera nenhuma linha existente.
CREATE OR REPLACE FUNCTION "crediai_guard_user_role"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."role" = 'SUPER_ADMIN'
     AND (TG_OP = 'INSERT' OR OLD."role" IS DISTINCT FROM 'SUPER_ADMIN')
     AND coalesce(current_setting('app.crediai_role_grant', true), '') <> 'promote' THEN
    RAISE EXCEPTION 'SUPER_ADMIN só pode ser concedido pelo procedimento administrativo.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "user_role_guard" BEFORE INSERT OR UPDATE OF "role" ON "user" FOR EACH ROW EXECUTE FUNCTION "crediai_guard_user_role"();
