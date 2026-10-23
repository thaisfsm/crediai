ALTER TABLE "investment_payment" ALTER COLUMN "capital_movement_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "investment_payment" ADD COLUMN "historical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "investment_payment" ADD CONSTRAINT "investment_payment_historical_no_movement" CHECK ("investment_payment"."historical" = ("investment_payment"."capital_movement_id" is null));--> statement-breakpoint
-- Baixa histórica: o gatilho da baixa passa a aceitar baixa sem saída de capital, só antes do início do ciclo do capital.
CREATE OR REPLACE FUNCTION "crediai_investment_payment_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item record;
  movement record;
  contract record;
  origin_rule text;
  expected bigint;
  paid bigint;
  wanted_category text;
  cycle_start date;
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
  SELECT start_date, capital_entry_rule, renewed_from_investment_id INTO contract FROM investment WHERE id = NEW.investment_id AND tenant_id = NEW.tenant_id;
  IF NEW.paid_on < contract.start_date THEN
    RAISE EXCEPTION 'Baixa com data anterior ao início do contrato.' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'PRINCIPAL' AND EXISTS (SELECT 1 FROM investment WHERE tenant_id = NEW.tenant_id AND renewed_from_investment_id = NEW.investment_id) THEN
    RAISE EXCEPTION 'Baixa: o principal deste contrato passou para a renovação.' USING ERRCODE = '23514';
  END IF;
  -- Baixa histórica (0033): só com data anterior ao início do ciclo do capital e sem saída de capital ligada. Não depende da
  -- entrada do contrato no capital (o pagamento é anterior ao capital) nem da saída; o saldo e o início do contrato valem.
  IF NEW.historical THEN
    SELECT (coalesce(cycle_started_at, created_at) AT TIME ZONE 'America/Sao_Paulo')::date INTO cycle_start FROM wallet WHERE tenant_id = NEW.tenant_id;
    IF NEW.capital_movement_id IS NOT NULL OR cycle_start IS NULL OR NEW.paid_on >= cycle_start THEN
      RAISE EXCEPTION 'Baixa histórica: só para datas anteriores ao início do capital e sem saída de capital.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT "crediai_investment_has_capital"(NEW.tenant_id, NEW.investment_id) THEN
    IF contract.renewed_from_investment_id IS NOT NULL THEN
      RAISE EXCEPTION 'Baixa: o contrato de origem desta renovação não tem a entrada no capital registrada.' USING ERRCODE = '23514';
    END IF;
    IF contract.capital_entry_rule IS NOT NULL THEN
      RAISE EXCEPTION 'Baixa: registre antes a entrada deste investimento no capital.' USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'Baixa: contrato anterior à regra da entrada sem a entrada registrada nem o aporte anterior indicado.' USING ERRCODE = '23514';
  END IF;
  SELECT kind::text AS kind, category, amount_cents, occurred_at INTO movement FROM capital_movement
    WHERE id = NEW.capital_movement_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR movement.kind <> 'WITHDRAWAL' OR movement.amount_cents <> NEW.amount_cents OR movement.occurred_at <> NEW.paid_on
    OR movement.category IS DISTINCT FROM wanted_category THEN
    RAISE EXCEPTION 'Baixa: a saída de capital ligada não confere com a baixa.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
