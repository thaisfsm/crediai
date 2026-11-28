CREATE TABLE "account_manager_commission_paid" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"manager_id" text NOT NULL,
	"payout_id" text NOT NULL,
	"kind" text NOT NULL,
	"reverses_id" text,
	"operation_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"client_id" text,
	"client_name" text NOT NULL,
	"operation_code" text,
	"loan_date" date,
	"principal_cents" bigint NOT NULL,
	"interest_rate_bps" numeric(9, 1) NOT NULL,
	"commission_bps" integer NOT NULL,
	"receipt_paid_on" date NOT NULL,
	"interest_cents" bigint NOT NULL,
	"commission_due_cents" bigint NOT NULL,
	"commission_cents" bigint NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_manager_commission_paid_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "account_manager_commission_paid_kind_valid" CHECK ("account_manager_commission_paid"."kind" in ('PAID', 'REVERSAL')),
	CONSTRAINT "account_manager_commission_paid_source_valid" CHECK ("account_manager_commission_paid"."source" in ('CLOSING', 'HISTORICAL')),
	CONSTRAINT "account_manager_commission_paid_reversal_pair" CHECK (("account_manager_commission_paid"."kind" = 'REVERSAL') = ("account_manager_commission_paid"."reverses_id" is not null)),
	CONSTRAINT "account_manager_commission_paid_values_valid" CHECK ("account_manager_commission_paid"."commission_cents" > 0 and "account_manager_commission_paid"."interest_cents" >= 0 and "account_manager_commission_paid"."commission_due_cents" >= 0 and "account_manager_commission_paid"."principal_cents" >= 0 and "account_manager_commission_paid"."interest_rate_bps" >= 0 and "account_manager_commission_paid"."commission_bps" >= 0 and "account_manager_commission_paid"."commission_bps" <= 10000 and ("account_manager_commission_paid"."kind" = 'REVERSAL' or "account_manager_commission_paid"."commission_cents" <= "account_manager_commission_paid"."commission_due_cents")),
	CONSTRAINT "account_manager_commission_paid_reason_required" CHECK (("account_manager_commission_paid"."kind" = 'PAID' and "account_manager_commission_paid"."source" = 'CLOSING') or length(trim(coalesce("account_manager_commission_paid"."reason", ''))) > 0),
	CONSTRAINT "account_manager_commission_paid_client_name_not_blank" CHECK (length(trim("account_manager_commission_paid"."client_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "account_manager_commission_paid" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_manager_commission_paid" ADD CONSTRAINT "account_manager_commission_paid_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_manager_commission_paid" ADD CONSTRAINT "account_manager_commission_paid_reverses_same_tenant_fk" FOREIGN KEY ("tenant_id","reverses_id") REFERENCES "public"."account_manager_commission_paid"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_manager_commission_paid" ADD CONSTRAINT "account_manager_commission_paid_payout_same_manager_fk" FOREIGN KEY ("tenant_id","manager_id","payout_id") REFERENCES "public"."account_manager_payout"("tenant_id","manager_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_manager_commission_paid_manager_idx" ON "account_manager_commission_paid" USING btree ("tenant_id","manager_id");--> statement-breakpoint
CREATE INDEX "account_manager_commission_paid_payout_idx" ON "account_manager_commission_paid" USING btree ("tenant_id","payout_id");--> statement-breakpoint
CREATE INDEX "account_manager_commission_paid_payment_idx" ON "account_manager_commission_paid" USING btree ("tenant_id","payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_manager_commission_paid_receipt_unique" ON "account_manager_commission_paid" USING btree ("tenant_id","payout_id","payment_id") WHERE "account_manager_commission_paid"."kind" = 'PAID';--> statement-breakpoint
CREATE POLICY "account_manager_commission_paid_select_tenant_or_admin" ON "account_manager_commission_paid" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_commission_paid"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_commission_paid_insert_own_or_admin" ON "account_manager_commission_paid" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_commission_paid"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_commission_paid_update_own_or_admin" ON "account_manager_commission_paid" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_commission_paid"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_commission_paid"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_commission_paid_delete_admin_only" ON "account_manager_commission_paid" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
-- CPG é histórico: não muda nem se apaga (a exclusão em cascata do tenant continua possível).
CREATE TRIGGER "account_manager_commission_paid_append_only" BEFORE UPDATE OR DELETE ON "account_manager_commission_paid" FOR EACH ROW EXECUTE FUNCTION "crediai_manager_payout_append_only"();--> statement-breakpoint
CREATE TRIGGER "account_manager_commission_paid_no_truncate" BEFORE TRUNCATE ON "account_manager_commission_paid" FOR EACH STATEMENT EXECUTE FUNCTION "crediai_manager_payout_append_only"();--> statement-breakpoint
-- Antes de gravar: uma gravação por gerente de cada vez (duas solicitações simultâneas esperam uma pela outra até o fim da transação) e o
-- estorno tem de apontar para uma linha PAGA do mesmo tenant, gerente, fechamento e recebimento.
CREATE OR REPLACE FUNCTION "crediai_commission_paid_before_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('crediai-cpg:' || NEW.tenant_id || ':' || NEW.manager_id, 0));
  IF NEW.kind = 'REVERSAL' THEN
    SELECT kind, manager_id, payout_id, payment_id INTO target FROM "account_manager_commission_paid" WHERE tenant_id = NEW.tenant_id AND id = NEW.reverses_id;
    IF NOT FOUND OR target.kind <> 'PAID' OR target.manager_id <> NEW.manager_id OR target.payout_id <> NEW.payout_id OR target.payment_id <> NEW.payment_id THEN
      RAISE EXCEPTION 'O estorno precisa apontar para uma comissão paga do mesmo gerente, fechamento e recebimento.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "account_manager_commission_paid_before_insert" BEFORE INSERT ON "account_manager_commission_paid" FOR EACH ROW EXECUTE FUNCTION "crediai_commission_paid_before_insert"();--> statement-breakpoint
-- No fim da transação:
--  1) o pago líquido do recebimento (pagos − estornos) fica entre 0 e a comissão que ele gerou: a mesma comissão nunca é paga duas vezes;
--  2) cada estorno não passa do que resta da linha estornada;
--  3) as linhas PAID de um fechamento são gravadas de uma vez só e somam exatamente o valor gravado nele. Junto com o fechamento
--     (origem CLOSING) ou, num fechamento antigo sem composição nem detalhamento, uma única reconstrução histórica (origem HISTORICAL).
CREATE OR REPLACE FUNCTION "crediai_commission_paid_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  net bigint; due bigint; left_on_row bigint; payout_amount bigint; payout_created timestamptz; paid_sum bigint; batches integer; items integer;
BEGIN
  SELECT coalesce(sum(CASE WHEN kind = 'PAID' THEN commission_cents ELSE -commission_cents END), 0) INTO net
    FROM "account_manager_commission_paid" WHERE tenant_id = NEW.tenant_id AND manager_id = NEW.manager_id AND payment_id = NEW.payment_id;
  IF net < 0 THEN
    RAISE EXCEPTION 'O estorno passa do que foi pago deste recebimento.' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'PAID' THEN
    due := NEW.commission_due_cents;
    IF net > due THEN
      RAISE EXCEPTION 'Esta comissão já foi paga: o recebimento não tem mais comissão pendente para este valor.' USING ERRCODE = '23514';
    END IF;
    SELECT amount_cents, created_at INTO payout_amount, payout_created FROM "account_manager_payout" WHERE tenant_id = NEW.tenant_id AND id = NEW.payout_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    SELECT coalesce(sum(commission_cents), 0), count(DISTINCT created_at) INTO paid_sum, batches
      FROM "account_manager_commission_paid" WHERE tenant_id = NEW.tenant_id AND payout_id = NEW.payout_id AND kind = 'PAID';
    IF batches > 1 THEN
      RAISE EXCEPTION 'A composição de um fechamento de comissão é gravada uma vez só.' USING ERRCODE = '42501';
    END IF;
    IF paid_sum <> payout_amount THEN
      RAISE EXCEPTION 'As comissões pagas por recebimento não somam o valor gravado no fechamento.' USING ERRCODE = '23514';
    END IF;
    IF NEW.source = 'CLOSING' AND payout_created <> now() THEN
      RAISE EXCEPTION 'A composição só pode ser gravada junto com o próprio fechamento (ou como reconstrução histórica com motivo).' USING ERRCODE = '42501';
    END IF;
    IF NEW.source = 'HISTORICAL' THEN
      SELECT count(*) INTO items FROM "account_manager_payout_item" WHERE tenant_id = NEW.tenant_id AND payout_id = NEW.payout_id;
      IF payout_created >= now() OR items > 0 THEN
        RAISE EXCEPTION 'Reconstrução histórica só vale para fechamento antigo sem composição registrada.' USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSE
    SELECT (SELECT commission_cents FROM "account_manager_commission_paid" WHERE tenant_id = NEW.tenant_id AND id = NEW.reverses_id)
      - coalesce(sum(commission_cents), 0) INTO left_on_row
      FROM "account_manager_commission_paid" WHERE tenant_id = NEW.tenant_id AND reverses_id = NEW.reverses_id AND kind = 'REVERSAL';
    IF left_on_row < 0 THEN
      RAISE EXCEPTION 'O estorno passa do que foi pago nesta linha.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "account_manager_commission_paid_check" AFTER INSERT ON "account_manager_commission_paid" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "crediai_commission_paid_check"();
