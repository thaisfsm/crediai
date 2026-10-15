CREATE TABLE "investor_bank_account" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"investor_id" text NOT NULL,
	"bank_code" text,
	"bank_name" text,
	"branch" text,
	"branch_digit" text,
	"account" text,
	"account_digit" text,
	"account_type" text,
	"holder_name" text,
	"holder_document" text,
	"pix_key_type" text,
	"pix_key" text,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investor_bank_account_tenant_investor_id_unique" UNIQUE("tenant_id","investor_id","id"),
	CONSTRAINT "investor_bank_account_code_valid" CHECK ("investor_bank_account"."bank_code" is null or "investor_bank_account"."bank_code" ~ '^[0-9]{3}$'),
	CONSTRAINT "investor_bank_account_branch_valid" CHECK ("investor_bank_account"."branch" is null or "investor_bank_account"."branch" ~ '^[0-9]{1,5}$'),
	CONSTRAINT "investor_bank_account_digits_valid" CHECK (("investor_bank_account"."branch_digit" is null or "investor_bank_account"."branch_digit" ~ '^[0-9X]$') and ("investor_bank_account"."account_digit" is null or "investor_bank_account"."account_digit" ~ '^[0-9X]$')),
	CONSTRAINT "investor_bank_account_account_valid" CHECK ("investor_bank_account"."account" is null or "investor_bank_account"."account" ~ '^[0-9]{1,20}$'),
	CONSTRAINT "investor_bank_account_type_valid" CHECK ("investor_bank_account"."account_type" is null or "investor_bank_account"."account_type" in ('CHECKING', 'SAVINGS', 'PAYMENT', 'SALARY')),
	CONSTRAINT "investor_bank_account_pix_pair" CHECK (("investor_bank_account"."pix_key" is null) = ("investor_bank_account"."pix_key_type" is null) and ("investor_bank_account"."pix_key_type" is null or "investor_bank_account"."pix_key_type" in ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM'))),
	CONSTRAINT "investor_bank_account_has_destination" CHECK (("investor_bank_account"."branch" is not null and "investor_bank_account"."account" is not null and ("investor_bank_account"."bank_code" is not null or "investor_bank_account"."bank_name" is not null)) or "investor_bank_account"."pix_key" is not null),
	CONSTRAINT "investor_bank_account_preferred_active" CHECK (not ("investor_bank_account"."is_preferred" and "investor_bank_account"."archived_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "investor_bank_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "investor_document" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"investor_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"uploaded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" text,
	CONSTRAINT "investor_document_kind_valid" CHECK ("investor_document"."kind" in ('IDENTITY', 'PROOF_OF_ADDRESS', 'COMPANY_RECORDS', 'BANK_PROOF', 'OTHER')),
	CONSTRAINT "investor_document_size_limit" CHECK ("investor_document"."size_bytes" > 0 and "investor_document"."size_bytes" <= 5242880),
	CONSTRAINT "investor_document_removed_link" CHECK (("investor_document"."removed_at" is null) = ("investor_document"."removed_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "investor_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "contracted_on" date;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "term_count" integer;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "term_unit" text;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "bank_account_id" text;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "yield_terms" text;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "principal_terms" text;--> statement-breakpoint
ALTER TABLE "investment" ADD COLUMN "renewed_from_investment_id" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "person_type" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "trade_name" text;--> statement-breakpoint
ALTER TABLE "investor" ADD COLUMN "birth_date" date;--> statement-breakpoint
ALTER TABLE "investor_bank_account" ADD CONSTRAINT "investor_bank_account_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor_bank_account" ADD CONSTRAINT "investor_bank_account_investor_same_tenant_fk" FOREIGN KEY ("tenant_id","investor_id") REFERENCES "public"."investor"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor_document" ADD CONSTRAINT "investor_document_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor_document" ADD CONSTRAINT "investor_document_investor_same_tenant_fk" FOREIGN KEY ("tenant_id","investor_id") REFERENCES "public"."investor"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investor_bank_account_investor_idx" ON "investor_bank_account" USING btree ("tenant_id","investor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investor_bank_account_preferred_unique" ON "investor_bank_account" USING btree ("investor_id") WHERE "investor_bank_account"."is_preferred" and "investor_bank_account"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "investor_document_investor_idx" ON "investor_document" USING btree ("tenant_id","investor_id");--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_renewed_from_same_tenant_fk" FOREIGN KEY ("tenant_id","renewed_from_investment_id") REFERENCES "public"."investment"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_bank_account_same_investor_fk" FOREIGN KEY ("tenant_id","investor_id","bank_account_id") REFERENCES "public"."investor_bank_account"("tenant_id","investor_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "investment_renewed_from_unique" ON "investment" USING btree ("renewed_from_investment_id") WHERE "investment"."renewed_from_investment_id" is not null;--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_term_pair" CHECK (("investment"."term_count" is null) = ("investment"."term_unit" is null) and ("investment"."term_unit" is null or "investment"."term_unit" in ('DAYS', 'MONTHS', 'YEARS')));--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_term_count_valid" CHECK ("investment"."term_count" is null or "investment"."term_count" between 1 and 18250);--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_payment_method_valid" CHECK ("investment"."payment_method" is null or "investment"."payment_method" in ('PIX', 'TRANSFER', 'CASH', 'OTHER'));--> statement-breakpoint
ALTER TABLE "investment" ADD CONSTRAINT "investment_renewed_from_not_self" CHECK ("investment"."renewed_from_investment_id" is null or "investment"."renewed_from_investment_id" <> "investment"."id");--> statement-breakpoint
ALTER TABLE "investor" ADD CONSTRAINT "investor_person_type_valid" CHECK ("investor"."person_type" is null or "investor"."person_type" in ('PF', 'PJ'));--> statement-breakpoint
ALTER TABLE "investor" ADD CONSTRAINT "investor_person_type_document" CHECK ("investor"."person_type" is null or "investor"."document" is null or ("investor"."person_type" = 'PF' and length("investor"."document") = 11) or ("investor"."person_type" = 'PJ' and length("investor"."document") = 14));--> statement-breakpoint
CREATE POLICY "admin_audit_log_insert_tenant_investor_records" ON "admin_audit_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'TENANT_USER' and "admin_audit_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') and "admin_audit_log"."entity" in ('investor_bank_account', 'investor_document'));--> statement-breakpoint
CREATE POLICY "investor_bank_account_select_tenant_or_admin" ON "investor_bank_account" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investor_bank_account"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investor_bank_account_insert_own_or_admin" ON "investor_bank_account" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investor_bank_account"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investor_bank_account_update_own_or_admin" ON "investor_bank_account" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investor_bank_account"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investor_bank_account"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investor_bank_account_delete_admin_only" ON "investor_bank_account" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "investor_document_select_tenant_or_admin" ON "investor_document" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investor_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investor_document_insert_own_or_admin" ON "investor_document" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investor_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investor_document_update_own_or_admin" ON "investor_document" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investor_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "investor_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "investor_document_delete_admin_only" ON "investor_document" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
-- O dinheiro de um contrato está no capital quando o contrato de ORIGEM da cadeia de renovações tem a entrada
-- registrada ou (contrato anterior à 0023) o aporte anterior indicado e não estornado. Renovação não lança nova entrada.
CREATE OR REPLACE FUNCTION "crediai_investment_has_capital"(p_tenant text, p_investment text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  current_id text := p_investment;
  parent text;
  rule text;
  steps integer := 0;
BEGIN
  LOOP
    SELECT renewed_from_investment_id, capital_entry_rule INTO parent, rule FROM investment WHERE id = current_id AND tenant_id = p_tenant;
    IF NOT FOUND THEN RETURN false; END IF;
    EXIT WHEN parent IS NULL;
    current_id := parent;
    steps := steps + 1;
    IF steps > 1000 THEN RETURN false; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM investment_capital_entry WHERE tenant_id = p_tenant AND investment_id = current_id) THEN RETURN true; END IF;
  RETURN rule IS NULL AND EXISTS (SELECT 1 FROM investment_prior_contribution prior WHERE prior.tenant_id = p_tenant AND prior.investment_id = current_id
    AND NOT EXISTS (SELECT 1 FROM capital_movement reversal WHERE reversal.tenant_id = prior.tenant_id AND reversal.reversed_movement_id = prior.capital_movement_id));
END;
$$;--> statement-breakpoint
-- Baixa: as mesmas regras da 0022/0023, com duas mudanças da renovação: (1) a evidência de que o dinheiro entrou no
-- capital vem do contrato de origem da cadeia; (2) contrato já renovado não recebe baixa de principal (o principal
-- ainda não devolvido passou para a renovação). Rendimento pendente do contrato anterior continua podendo ser pago.
CREATE OR REPLACE FUNCTION "crediai_investment_payment_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item record;
  movement record;
  contract record;
  origin_rule text;
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
  SELECT start_date, capital_entry_rule, renewed_from_investment_id INTO contract FROM investment WHERE id = NEW.investment_id AND tenant_id = NEW.tenant_id;
  IF NEW.paid_on < contract.start_date THEN
    RAISE EXCEPTION 'Baixa com data anterior ao início do contrato.' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'PRINCIPAL' AND EXISTS (SELECT 1 FROM investment WHERE tenant_id = NEW.tenant_id AND renewed_from_investment_id = NEW.investment_id) THEN
    RAISE EXCEPTION 'Baixa: o principal deste contrato passou para a renovação.' USING ERRCODE = '23514';
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
$$;--> statement-breakpoint
-- Entrada do contrato (regras da 0023) e, agora, nunca em contrato de renovação (o dinheiro já está no capital).
CREATE OR REPLACE FUNCTION "crediai_investment_capital_entry_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  movement record;
  contract record;
BEGIN
  SELECT renewed_from_investment_id INTO contract FROM investment WHERE id = NEW.investment_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF contract.renewed_from_investment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Entrada do investimento: contrato de renovação não tem nova entrada; o dinheiro veio do contrato anterior.' USING ERRCODE = '23514';
  END IF;
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
-- Renovação: só de contrato não cancelado, do mesmo investidor, com o dinheiro no capital, e com o valor igual ao
-- principal ainda não devolvido do anterior. Depois, o vínculo e o valor do contrato renovado não mudam, e nenhum dos
-- dois contratos da renovação pode ser cancelado.
CREATE OR REPLACE FUNCTION "crediai_investment_renewal_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous record;
  returned bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.renewed_from_investment_id IS NULL THEN RETURN NEW; END IF;
    SELECT investor_id, amount_cents, status::text AS status INTO previous FROM investment
      WHERE id = NEW.renewed_from_investment_id AND tenant_id = NEW.tenant_id FOR NO KEY UPDATE;
    IF NOT FOUND OR previous.investor_id <> NEW.investor_id OR previous.status = 'CANCELED' THEN
      RAISE EXCEPTION 'Renovação: o contrato anterior precisa ser do mesmo investidor e não estar cancelado.' USING ERRCODE = '23514';
    END IF;
    IF NOT "crediai_investment_has_capital"(NEW.tenant_id, NEW.renewed_from_investment_id) THEN
      RAISE EXCEPTION 'Renovação: o dinheiro do contrato anterior não está registrado no capital.' USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(sum(amount_cents), 0) INTO returned FROM investment_payment
      WHERE tenant_id = NEW.tenant_id AND investment_id = NEW.renewed_from_investment_id AND kind = 'PRINCIPAL';
    IF NEW.amount_cents <> previous.amount_cents - returned THEN
      RAISE EXCEPTION 'Renovação: o valor precisa ser o principal ainda não devolvido do contrato anterior.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.renewed_from_investment_id IS DISTINCT FROM OLD.renewed_from_investment_id THEN
    RAISE EXCEPTION 'O vínculo de renovação de um contrato não muda.' USING ERRCODE = '23514';
  END IF;
  IF NEW.renewed_from_investment_id IS NOT NULL AND NEW.amount_cents <> OLD.amount_cents THEN
    RAISE EXCEPTION 'Contrato de renovação: o valor (principal que veio do contrato anterior) não muda.' USING ERRCODE = '23514';
  END IF;
  IF NEW.status::text = 'CANCELED' AND OLD.status::text <> 'CANCELED' AND (NEW.renewed_from_investment_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM investment WHERE tenant_id = OLD.tenant_id AND renewed_from_investment_id = OLD.id)) THEN
    RAISE EXCEPTION 'Contrato de uma renovação não pode ser cancelado.' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM investment WHERE tenant_id = OLD.tenant_id AND renewed_from_investment_id = OLD.id)
    AND (NEW.amount_cents <> OLD.amount_cents OR NEW.investor_id <> OLD.investor_id) THEN
    RAISE EXCEPTION 'Contrato já renovado: o valor e o investidor não mudam.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "investment_renewal_check" BEFORE INSERT OR UPDATE ON "investment" FOR EACH ROW EXECUTE FUNCTION "crediai_investment_renewal_check"();
