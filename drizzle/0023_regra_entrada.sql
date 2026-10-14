-- Regra da entrada no capital para a baixa de investidores. Só acrescenta estrutura:
--   * investment.capital_entry_rule (coluna nova, SEM valor padrão e SEM backfill): os contratos que já existem ficam com
--     NULL, que quer dizer "cadastrado antes desta regra". Nenhuma linha existente é alterada.
--   * todo contrato cadastrado depois desta migração recebe 'REQUIRED' por gatilho (mesmo que alguém mande NULL) e o
--     valor não muda depois. Contrato 'REQUIRED' só recebe baixa com a entrada do contrato registrada no capital.
--   * tabela investment_prior_contribution: para contrato antigo (NULL), o usuário indica o aporte comum pelo qual o
--     dinheiro já entrou; com a entrada OU esse aporte indicado a baixa passa. Sem nenhum dos dois, a baixa é recusada
--     com explicação (nada é classificado em silêncio). Entrada e aporte indicado se excluem (não contar em dobro).
--   * o aporte indicado não pode mais ser estornado.
--   * contrato ligado ao capital também fica protegido no banco: não é cancelado; com entrada, valor e data não mudam;
--     com baixa, a data de início não muda (as mesmas travas que o servidor já aplicava desde a 0022).
-- Carteiras, operações, pagamentos, investidores, contratos, cronogramas, baixas e movimentos ficam como estão. Nada é
-- lançado no capital por esta migração.
CREATE TABLE "investment_prior_contribution" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"investment_id" text NOT NULL,
	"capital_movement_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "investment_prior_contribution" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "capital_entry_rule" text;--> statement-breakpoint
ALTER TABLE "investment_prior_contribution" ADD CONSTRAINT "investment_prior_contribution_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_prior_contribution" ADD CONSTRAINT "investment_prior_contribution_investment_same_tenant_fk" FOREIGN KEY ("tenant_id","investment_id") REFERENCES "public"."investment"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_prior_contribution" ADD CONSTRAINT "investment_prior_contribution_movement_same_tenant_fk" FOREIGN KEY ("tenant_id","capital_movement_id") REFERENCES "public"."capital_movement"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "investment_prior_contribution_investment_unique" ON "investment_prior_contribution" USING btree ("investment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_prior_contribution_tenant_idempotency_unique" ON "investment_prior_contribution" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "investment_prior_contribution_movement_idx" ON "investment_prior_contribution" USING btree ("tenant_id","capital_movement_id");--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_capital_entry_rule_valid" CHECK ("investment"."capital_entry_rule" is null or "investment"."capital_entry_rule" = 'REQUIRED');--> statement-breakpoint
CREATE POLICY "investment_prior_contribution_select_tenant_or_admin" ON "investment_prior_contribution" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_prior_contribution"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_prior_contribution_insert_own_or_admin" ON "investment_prior_contribution" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_prior_contribution"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_prior_contribution_update_admin_only" ON "investment_prior_contribution" AS PERMISSIVE FOR UPDATE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN') WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "investment_prior_contribution_delete_admin_only" ON "investment_prior_contribution" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
COMMENT ON COLUMN "investment"."capital_entry_rule" IS 'REQUIRED = cadastrado com a regra da entrada (baixa exige a entrada no capital). NULL = já existia quando a migração 0023 rodou (baixa exige a entrada ou o aporte anterior indicado).';--> statement-breakpoint
-- Contrato novo sempre nasce com a regra; o valor não muda depois (nem para NULL, nem de NULL para REQUIRED).
CREATE OR REPLACE FUNCTION "crediai_investment_entry_rule"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.capital_entry_rule := 'REQUIRED';
  ELSIF NEW.capital_entry_rule IS DISTINCT FROM OLD.capital_entry_rule THEN
    RAISE EXCEPTION 'A regra da entrada no capital de um contrato não pode ser alterada.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "investment_entry_rule" BEFORE INSERT OR UPDATE ON "investment" FOR EACH ROW EXECUTE FUNCTION "crediai_investment_entry_rule"();--> statement-breakpoint
-- Contrato ligado ao capital (proteção também no banco, além do servidor): com entrada, aporte anterior indicado ou baixa,
-- o contrato não é cancelado nem trocado de carteira ou de investidor; com entrada, o valor e a data da entrada não
-- mudam; com baixa, a data de início não muda.
CREATE OR REPLACE FUNCTION "crediai_investment_cash_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  has_entry boolean;
  has_prior boolean;
  has_payment boolean;
BEGIN
  has_entry := EXISTS (SELECT 1 FROM investment_capital_entry WHERE tenant_id = OLD.tenant_id AND investment_id = OLD.id);
  has_prior := EXISTS (SELECT 1 FROM investment_prior_contribution WHERE tenant_id = OLD.tenant_id AND investment_id = OLD.id);
  has_payment := EXISTS (SELECT 1 FROM investment_payment WHERE tenant_id = OLD.tenant_id AND investment_id = OLD.id);
  IF has_entry OR has_prior OR has_payment THEN
    IF NEW.status::text = 'CANCELED' AND OLD.status::text <> 'CANCELED' THEN
      RAISE EXCEPTION 'Contrato ligado ao capital (entrada, aporte anterior ou baixa) não pode ser cancelado.' USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.investor_id <> OLD.investor_id THEN
      RAISE EXCEPTION 'Contrato ligado ao capital não muda de carteira nem de investidor.' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF has_entry AND (NEW.amount_cents <> OLD.amount_cents OR coalesce(NEW.invested_on, NEW.start_date) <> coalesce(OLD.invested_on, OLD.start_date)) THEN
    RAISE EXCEPTION 'Entrada já registrada no capital: o valor e a data do investimento não mudam.' USING ERRCODE = '23514';
  END IF;
  IF has_payment AND NEW.start_date <> OLD.start_date THEN
    RAISE EXCEPTION 'Contrato com baixa registrada: a data de início não muda.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "investment_cash_guard" BEFORE UPDATE ON "investment" FOR EACH ROW EXECUTE FUNCTION "crediai_investment_cash_guard"();--> statement-breakpoint
-- Baixa (mesmas regras da 0022) + a regra da entrada: contrato REQUIRED só com a entrada registrada; contrato antigo
-- (NULL) com a entrada ou com o aporte anterior indicado e não estornado.
CREATE OR REPLACE FUNCTION "crediai_investment_payment_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item record;
  movement record;
  contract record;
  expected bigint;
  paid bigint;
  wanted_category text;
BEGIN
  SELECT investment_id, yield_cents, principal_cents INTO item FROM investment_schedule_item
    WHERE id = NEW.schedule_item_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND OR item.investment_id <> NEW.investment_id THEN
    RAISE EXCEPTION 'Baixa: a obrigação não pertence a este contrato.' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'YIELD' THEN
    expected := item.yield_cents;
    wanted_category := 'INVESTOR_YIELD_PAYMENT';
  ELSE
    expected := item.principal_cents;
    wanted_category := 'INVESTOR_PRINCIPAL_RETURN';
  END IF;
  SELECT coalesce(sum(amount_cents), 0) INTO paid FROM investment_payment
    WHERE tenant_id = NEW.tenant_id AND schedule_item_id = NEW.schedule_item_id AND kind = NEW.kind;
  IF paid + NEW.amount_cents > expected THEN
    RAISE EXCEPTION 'Baixa acima do saldo da obrigação.' USING ERRCODE = '23514';
  END IF;
  SELECT start_date, capital_entry_rule INTO contract FROM investment WHERE id = NEW.investment_id AND tenant_id = NEW.tenant_id;
  IF NEW.paid_on < contract.start_date THEN
    RAISE EXCEPTION 'Baixa com data anterior ao início do contrato.' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM investment_capital_entry WHERE tenant_id = NEW.tenant_id AND investment_id = NEW.investment_id) THEN
    IF contract.capital_entry_rule IS NOT NULL THEN
      RAISE EXCEPTION 'Baixa: registre antes a entrada deste investimento no capital.' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM investment_prior_contribution prior WHERE prior.tenant_id = NEW.tenant_id AND prior.investment_id = NEW.investment_id
      AND NOT EXISTS (SELECT 1 FROM capital_movement reversal WHERE reversal.tenant_id = prior.tenant_id AND reversal.reversed_movement_id = prior.capital_movement_id)) THEN
      RAISE EXCEPTION 'Baixa: contrato anterior à regra da entrada sem a entrada registrada nem o aporte anterior indicado.' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT kind::text AS kind, category, amount_cents, occurred_at INTO movement FROM capital_movement
    WHERE id = NEW.capital_movement_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR movement.kind <> 'WITHDRAWAL' OR movement.amount_cents <> NEW.amount_cents OR movement.occurred_at <> NEW.paid_on
    OR movement.category IS DISTINCT FROM wanted_category THEN
    RAISE EXCEPTION 'Baixa: a saída de capital ligada não confere com a baixa.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Entrada do contrato (mesmas regras da 0022) e, agora, nunca junto com um aporte anterior indicado. O contrato é
-- travado para que entrada e indicação simultâneas esperem uma pela outra.
CREATE OR REPLACE FUNCTION "crediai_investment_capital_entry_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  movement record;
BEGIN
  PERFORM 1 FROM investment WHERE id = NEW.investment_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM investment_prior_contribution WHERE tenant_id = NEW.tenant_id AND investment_id = NEW.investment_id) THEN
    RAISE EXCEPTION 'Entrada do investimento: o aporte anterior deste contrato já foi indicado; a entrada contaria o dinheiro em dobro.' USING ERRCODE = '23514';
  END IF;
  SELECT kind::text AS kind, category, amount_cents, occurred_at INTO movement FROM capital_movement
    WHERE id = NEW.capital_movement_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR movement.kind <> 'CONTRIBUTION' OR movement.category IS DISTINCT FROM 'INVESTOR_CONTRIBUTION'
    OR movement.amount_cents <> NEW.amount_cents OR movement.occurred_at <> NEW.entered_on THEN
    RAISE EXCEPTION 'Entrada do investimento: o aporte ligado não confere.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Aporte anterior: só contrato antigo (NULL), não cancelado, sem entrada; o movimento é um aporte comum (CONTRIBUTION
-- que não é de investidor) do mesmo tenant e não estornado. Contrato e aporte ficam travados durante a conferência.
CREATE OR REPLACE FUNCTION "crediai_investment_prior_contribution_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  contract record;
  movement record;
BEGIN
  SELECT status::text AS status, capital_entry_rule INTO contract FROM investment WHERE id = NEW.investment_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND OR contract.capital_entry_rule IS NOT NULL OR contract.status = 'CANCELED' THEN
    RAISE EXCEPTION 'Aporte anterior: só vale para contrato cadastrado antes da regra da entrada e não cancelado.' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM investment_capital_entry WHERE tenant_id = NEW.tenant_id AND investment_id = NEW.investment_id) THEN
    RAISE EXCEPTION 'Aporte anterior: a entrada deste contrato já está registrada no capital.' USING ERRCODE = '23514';
  END IF;
  SELECT kind::text AS kind, source INTO movement FROM capital_movement WHERE id = NEW.capital_movement_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND OR movement.kind <> 'CONTRIBUTION' OR movement.source = 'INVESTOR'
    OR EXISTS (SELECT 1 FROM capital_movement reversal WHERE reversal.tenant_id = NEW.tenant_id AND reversal.reversed_movement_id = NEW.capital_movement_id) THEN
    RAISE EXCEPTION 'Aporte anterior: o movimento indicado não é um aporte comum válido desta carteira.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "investment_prior_contribution_check" BEFORE INSERT ON "investment_prior_contribution" FOR EACH ROW EXECUTE FUNCTION "crediai_investment_prior_contribution_check"();--> statement-breakpoint
CREATE TRIGGER "investment_prior_contribution_append_only" BEFORE UPDATE OR DELETE ON "investment_prior_contribution" FOR EACH ROW EXECUTE FUNCTION "crediai_investor_cash_append_only"();--> statement-breakpoint
CREATE TRIGGER "investment_prior_contribution_no_truncate" BEFORE TRUNCATE ON "investment_prior_contribution" FOR EACH STATEMENT EXECUTE FUNCTION "crediai_investor_cash_append_only"();--> statement-breakpoint
-- O aporte indicado como origem do dinheiro de um contrato não pode ser estornado (a baixa do contrato depende dele).
CREATE OR REPLACE FUNCTION "crediai_prior_contribution_not_reversed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM capital_movement WHERE id = NEW.reversed_movement_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM investment_prior_contribution WHERE tenant_id = NEW.tenant_id AND capital_movement_id = NEW.reversed_movement_id) THEN
    RAISE EXCEPTION 'Este aporte foi indicado como a entrada do dinheiro de um contrato de investidor e não pode ser estornado.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "capital_movement_prior_contribution_not_reversed" BEFORE INSERT ON "capital_movement" FOR EACH ROW WHEN (NEW.kind = 'CONTRIBUTION_REVERSAL') EXECUTE FUNCTION "crediai_prior_contribution_not_reversed"();
