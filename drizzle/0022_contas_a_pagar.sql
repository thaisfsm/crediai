-- Contas a Pagar (Etapa C): baixas das obrigações do cronograma dos investidores e a entrada confirmada do dinheiro de
-- um contrato no capital. Só acrescenta estrutura: duas tabelas novas (investment_capital_entry e investment_payment), a
-- origem INVESTOR e três categorias novas em capital_movement (as regras de tipo e categoria são recriadas com as listas
-- antigas MAIS as novas, então todas as linhas existentes continuam válidas), uma política de auditoria e gatilhos de
-- integridade. Nenhuma linha existente é alterada, recalculada ou apagada; carteiras, operações, pagamentos, investidores,
-- contratos e cronogramas ficam como estão. Nada é lançado no capital por esta migração.
CREATE TABLE "investment_capital_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"investment_id" text NOT NULL,
	"capital_movement_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"entered_on" date NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_capital_entry_amount_positive" CHECK ("investment_capital_entry"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "investment_capital_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "investment_payment" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"investment_id" text NOT NULL,
	"schedule_item_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"paid_on" date NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"notes" text,
	"capital_movement_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_payment_amount_positive" CHECK ("investment_payment"."amount_cents" > 0),
	CONSTRAINT "investment_payment_kind_valid" CHECK ("investment_payment"."kind" in ('YIELD', 'PRINCIPAL')),
	CONSTRAINT "investment_payment_method_valid" CHECK ("investment_payment"."method" in ('PIX', 'TRANSFER', 'CASH', 'OTHER'))
);
--> statement-breakpoint
ALTER TABLE "investment_payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "capital_movement" DROP CONSTRAINT "capital_movement_source_valid";--> statement-breakpoint
ALTER TABLE "capital_movement" DROP CONSTRAINT "capital_movement_category_matches_kind";--> statement-breakpoint
ALTER TABLE "investment_capital_entry" ADD CONSTRAINT "investment_capital_entry_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_capital_entry" ADD CONSTRAINT "investment_capital_entry_investment_same_tenant_fk" FOREIGN KEY ("tenant_id","investment_id") REFERENCES "public"."investment"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_capital_entry" ADD CONSTRAINT "investment_capital_entry_movement_same_tenant_fk" FOREIGN KEY ("tenant_id","capital_movement_id") REFERENCES "public"."capital_movement"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_payment" ADD CONSTRAINT "investment_payment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_payment" ADD CONSTRAINT "investment_payment_investment_same_tenant_fk" FOREIGN KEY ("tenant_id","investment_id") REFERENCES "public"."investment"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_payment" ADD CONSTRAINT "investment_payment_schedule_item_same_tenant_fk" FOREIGN KEY ("tenant_id","schedule_item_id") REFERENCES "public"."investment_schedule_item"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_payment" ADD CONSTRAINT "investment_payment_movement_same_tenant_fk" FOREIGN KEY ("tenant_id","capital_movement_id") REFERENCES "public"."capital_movement"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "investment_capital_entry_investment_unique" ON "investment_capital_entry" USING btree ("investment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_capital_entry_movement_unique" ON "investment_capital_entry" USING btree ("capital_movement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_capital_entry_tenant_idempotency_unique" ON "investment_capital_entry" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "investment_payment_tenant_item_idx" ON "investment_payment" USING btree ("tenant_id","schedule_item_id");--> statement-breakpoint
CREATE INDEX "investment_payment_investment_idx" ON "investment_payment" USING btree ("investment_id","paid_on");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_payment_movement_unique" ON "investment_payment" USING btree ("capital_movement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_payment_tenant_idempotency_unique" ON "investment_payment" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "capital_movement" ADD CONSTRAINT "capital_movement_investor_fields" CHECK (("capital_movement"."source" = 'INVESTOR') = (coalesce("capital_movement"."category", '') in ('INVESTOR_CONTRIBUTION', 'INVESTOR_YIELD_PAYMENT', 'INVESTOR_PRINCIPAL_RETURN'))
    and ("capital_movement"."source" <> 'INVESTOR' or (length(trim(coalesce("capital_movement"."description", ''))) > 0 and "capital_movement"."idempotency_key" is not null)));--> statement-breakpoint
ALTER TABLE "capital_movement" ADD CONSTRAINT "capital_movement_source_valid" CHECK ("capital_movement"."source" in ('CAPITAL', 'FINANCE', 'INVESTOR'));--> statement-breakpoint
ALTER TABLE "capital_movement" ADD CONSTRAINT "capital_movement_category_matches_kind" CHECK (("capital_movement"."category" is null and "capital_movement"."kind"::text <> 'OTHER_INCOME')
    or ("capital_movement"."kind"::text = 'CONTRIBUTION' and "capital_movement"."category" in ('CAPITAL_CONTRIBUTION', 'INVESTOR_CONTRIBUTION'))
    or ("capital_movement"."kind"::text = 'OTHER_INCOME' and "capital_movement"."category" = 'OTHER_INCOME')
    or ("capital_movement"."kind"::text = 'WITHDRAWAL' and "capital_movement"."category" in ('SALARY_WITHDRAWAL', 'PARTNER_WITHDRAWAL', 'OPERATING_EXPENSE', 'TAXES_AND_FEES', 'OTHER_OUTFLOW', 'INVESTOR_YIELD_PAYMENT', 'INVESTOR_PRINCIPAL_RETURN')));--> statement-breakpoint
CREATE POLICY "admin_audit_log_insert_tenant_payables" ON "admin_audit_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'TENANT_USER' and "admin_audit_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') and "admin_audit_log"."entity" = 'investment_payment');--> statement-breakpoint
CREATE POLICY "investment_capital_entry_select_tenant_or_admin" ON "investment_capital_entry" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_capital_entry"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_capital_entry_insert_own_or_admin" ON "investment_capital_entry" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_capital_entry"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_capital_entry_update_admin_only" ON "investment_capital_entry" AS PERMISSIVE FOR UPDATE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN') WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "investment_capital_entry_delete_admin_only" ON "investment_capital_entry" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "investment_payment_select_tenant_or_admin" ON "investment_payment" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_payment"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_payment_insert_own_or_admin" ON "investment_payment" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investment_payment"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investment_payment_update_admin_only" ON "investment_payment" AS PERMISSIVE FOR UPDATE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN') WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "investment_payment_delete_admin_only" ON "investment_payment" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
-- Integridade da baixa: a linha do cronograma é travada, pertence ao mesmo contrato e tenant, a soma das baixas do tipo
-- nunca passa do valor previsto, a data não é anterior ao início do contrato e a saída de capital ligada é exatamente uma
-- retirada da categoria certa, do mesmo valor e da mesma data.
CREATE OR REPLACE FUNCTION "crediai_investment_payment_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item record;
  movement record;
  started date;
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
  SELECT start_date INTO started FROM investment WHERE id = NEW.investment_id AND tenant_id = NEW.tenant_id;
  IF NEW.paid_on < started THEN
    RAISE EXCEPTION 'Baixa com data anterior ao início do contrato.' USING ERRCODE = '23514';
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
CREATE TRIGGER "investment_payment_check" BEFORE INSERT ON "investment_payment" FOR EACH ROW EXECUTE FUNCTION "crediai_investment_payment_check"();--> statement-breakpoint
-- Entrada do contrato no capital: o aporte ligado é exatamente um CONTRIBUTION de investidor do mesmo valor e data.
CREATE OR REPLACE FUNCTION "crediai_investment_capital_entry_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  movement record;
BEGIN
  SELECT kind::text AS kind, category, amount_cents, occurred_at INTO movement FROM capital_movement
    WHERE id = NEW.capital_movement_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR movement.kind <> 'CONTRIBUTION' OR movement.category IS DISTINCT FROM 'INVESTOR_CONTRIBUTION'
    OR movement.amount_cents <> NEW.amount_cents OR movement.occurred_at <> NEW.entered_on THEN
    RAISE EXCEPTION 'Entrada do investimento: o aporte ligado não confere.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "investment_capital_entry_check" BEFORE INSERT ON "investment_capital_entry" FOR EACH ROW EXECUTE FUNCTION "crediai_investment_capital_entry_check"();--> statement-breakpoint
-- Baixas e entradas confirmadas não se alteram nem se apagam (nem com um papel que ignora RLS). Só a exclusão em
-- cascata do próprio tenant (vinda de outro gatilho, pg_trigger_depth() > 1) passa.
CREATE OR REPLACE FUNCTION "crediai_investor_cash_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Pagamentos e entradas de investidores confirmados não podem ser alterados nem apagados.' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "investment_payment_append_only" BEFORE UPDATE OR DELETE ON "investment_payment" FOR EACH ROW EXECUTE FUNCTION "crediai_investor_cash_append_only"();--> statement-breakpoint
CREATE TRIGGER "investment_payment_no_truncate" BEFORE TRUNCATE ON "investment_payment" FOR EACH STATEMENT EXECUTE FUNCTION "crediai_investor_cash_append_only"();--> statement-breakpoint
CREATE TRIGGER "investment_capital_entry_append_only" BEFORE UPDATE OR DELETE ON "investment_capital_entry" FOR EACH ROW EXECUTE FUNCTION "crediai_investor_cash_append_only"();--> statement-breakpoint
CREATE TRIGGER "investment_capital_entry_no_truncate" BEFORE TRUNCATE ON "investment_capital_entry" FOR EACH STATEMENT EXECUTE FUNCTION "crediai_investor_cash_append_only"();--> statement-breakpoint
-- Movimento de capital de investidor não se altera (a exclusão já é barrada pelas chaves estrangeiras das baixas).
CREATE OR REPLACE FUNCTION "crediai_investor_movement_locked"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source = 'INVESTOR' THEN
    RAISE EXCEPTION 'Movimentos de capital de investidores não podem ser alterados.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "capital_movement_investor_locked" BEFORE UPDATE ON "capital_movement" FOR EACH ROW EXECUTE FUNCTION "crediai_investor_movement_locked"();--> statement-breakpoint
-- Todo movimento de investidor precisa terminar a transação ligado a uma baixa ou a uma entrada de contrato.
CREATE OR REPLACE FUNCTION "crediai_investor_movement_linked"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM investment_payment WHERE capital_movement_id = NEW.id)
    AND NOT EXISTS (SELECT 1 FROM investment_capital_entry WHERE capital_movement_id = NEW.id) THEN
    RAISE EXCEPTION 'Movimento de capital de investidor sem baixa ou entrada ligada.' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "capital_movement_investor_linked" AFTER INSERT ON "capital_movement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source = 'INVESTOR') EXECUTE FUNCTION "crediai_investor_movement_linked"();--> statement-breakpoint
-- Linha do cronograma com baixa: não troca de contrato e o valor previsto de cada tipo não fica abaixo do já pago.
CREATE OR REPLACE FUNCTION "crediai_schedule_item_paid_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  paid_yield bigint;
  paid_principal bigint;
BEGIN
  SELECT coalesce(sum(amount_cents) FILTER (WHERE kind = 'YIELD'), 0), coalesce(sum(amount_cents) FILTER (WHERE kind = 'PRINCIPAL'), 0)
    INTO paid_yield, paid_principal FROM investment_payment WHERE tenant_id = OLD.tenant_id AND schedule_item_id = OLD.id;
  IF (paid_yield > 0 OR paid_principal > 0) AND (NEW.investment_id <> OLD.investment_id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.yield_cents < paid_yield OR NEW.principal_cents < paid_principal) THEN
    RAISE EXCEPTION 'Esta linha do cronograma já tem pagamento registrado.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "investment_schedule_item_paid_guard" BEFORE UPDATE ON "investment_schedule_item" FOR EACH ROW EXECUTE FUNCTION "crediai_schedule_item_paid_guard"();