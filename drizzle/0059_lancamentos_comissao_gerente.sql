CREATE TABLE "account_manager_adjustment" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"manager_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"entry_date" date NOT NULL,
	"payout_id" text,
	"applied_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_manager_adjustment_kind_valid" CHECK ("account_manager_adjustment"."kind" in ('DEBIT', 'CREDIT')),
	CONSTRAINT "account_manager_adjustment_amount_positive" CHECK ("account_manager_adjustment"."amount_cents" > 0),
	CONSTRAINT "account_manager_adjustment_description_not_blank" CHECK (length(trim("account_manager_adjustment"."description")) > 0),
	CONSTRAINT "account_manager_adjustment_applied_pair" CHECK (("account_manager_adjustment"."payout_id" is null) = ("account_manager_adjustment"."applied_at" is null))
);
--> statement-breakpoint
ALTER TABLE "account_manager_adjustment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_manager_payout" ADD COLUMN "debit_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_manager_payout" ADD COLUMN "credit_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_manager_payout" ADD CONSTRAINT "account_manager_payout_tenant_manager_id_unique" UNIQUE("tenant_id","manager_id","id");--> statement-breakpoint
ALTER TABLE "account_manager_adjustment" ADD CONSTRAINT "account_manager_adjustment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_manager_adjustment" ADD CONSTRAINT "account_manager_adjustment_manager_same_tenant_fk" FOREIGN KEY ("tenant_id","manager_id") REFERENCES "public"."account_manager"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_manager_adjustment" ADD CONSTRAINT "account_manager_adjustment_payout_same_manager_fk" FOREIGN KEY ("tenant_id","manager_id","payout_id") REFERENCES "public"."account_manager_payout"("tenant_id","manager_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_manager_adjustment_manager_idx" ON "account_manager_adjustment" USING btree ("tenant_id","manager_id");--> statement-breakpoint
CREATE INDEX "account_manager_adjustment_payout_idx" ON "account_manager_adjustment" USING btree ("tenant_id","payout_id");--> statement-breakpoint
ALTER TABLE "account_manager_payout" ADD CONSTRAINT "account_manager_payout_adjustments_valid" CHECK ("account_manager_payout"."debit_cents" >= 0 and "account_manager_payout"."credit_cents" >= 0 and "account_manager_payout"."amount_cents" - "account_manager_payout"."debit_cents" + "account_manager_payout"."credit_cents" >= 0);--> statement-breakpoint
CREATE POLICY "account_manager_adjustment_select_tenant_or_admin" ON "account_manager_adjustment" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_adjustment"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_adjustment_insert_own_or_admin" ON "account_manager_adjustment" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_adjustment"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_adjustment_update_own_or_admin" ON "account_manager_adjustment" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_adjustment"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_adjustment"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_adjustment_delete_own_or_admin" ON "account_manager_adjustment" AS PERMISSIVE FOR DELETE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_adjustment"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
ALTER POLICY "admin_audit_log_insert_tenant_managers" ON "admin_audit_log" TO public WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'TENANT_USER' and "admin_audit_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '') and "admin_audit_log"."entity" in ('account_manager', 'account_manager_payout', 'account_manager_adjustment'));--> statement-breakpoint
-- Lançamento aplicado é definitivo: não muda, não volta a pendente, não vai para outro fechamento e não se apaga (a exclusão em cascata
-- do tenant continua possível). Pendente só pode ser aplicado (payout_id + applied_at, nada mais) ou excluído.
CREATE OR REPLACE FUNCTION "crediai_manager_adjustment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.payout_id IS NULL OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Lançamento já aplicado em um fechamento de comissão não pode ser apagado.' USING ERRCODE = '42501';
  END IF;
  IF OLD.payout_id IS NOT NULL THEN
    RAISE EXCEPTION 'Lançamento já aplicado em um fechamento de comissão não pode ser alterado nem aplicado de novo.' USING ERRCODE = '42501';
  END IF;
  IF NEW.payout_id IS NULL OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.manager_id <> OLD.manager_id OR NEW.kind <> OLD.kind
     OR NEW.description <> OLD.description OR NEW.amount_cents <> OLD.amount_cents OR NEW.entry_date <> OLD.entry_date
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Lançamento pendente só pode ser aplicado em um fechamento (ou excluído).' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "account_manager_adjustment_guard" BEFORE UPDATE OR DELETE ON "account_manager_adjustment" FOR EACH ROW EXECUTE FUNCTION "crediai_manager_adjustment_guard"();--> statement-breakpoint
CREATE TRIGGER "account_manager_adjustment_no_truncate" BEFORE TRUNCATE ON "account_manager_adjustment" FOR EACH STATEMENT EXECUTE FUNCTION "crediai_manager_payout_append_only"();--> statement-breakpoint
-- Os totais gravados no fechamento (débitos e créditos) têm de bater com os lançamentos ligados a ele, conferido no fim da transação.
-- Assim nenhum lançamento entra depois num fechamento já feito (os fechamentos anteriores não mudam) e nada conta em dobro.
CREATE OR REPLACE FUNCTION "crediai_manager_payout_adjustments_match"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_tenant text; target_payout text; payout_debit bigint; payout_credit bigint; linked_debit bigint; linked_credit bigint;
BEGIN
  IF TG_TABLE_NAME = 'account_manager_payout' THEN
    target_tenant := NEW.tenant_id; target_payout := NEW.id;
  ELSE
    target_tenant := NEW.tenant_id; target_payout := NEW.payout_id;
  END IF;
  IF target_payout IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT debit_cents, credit_cents INTO payout_debit, payout_credit FROM "account_manager_payout" WHERE tenant_id = target_tenant AND id = target_payout;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(amount_cents) FILTER (WHERE kind = 'DEBIT'), 0), coalesce(sum(amount_cents) FILTER (WHERE kind = 'CREDIT'), 0)
    INTO linked_debit, linked_credit FROM "account_manager_adjustment" WHERE tenant_id = target_tenant AND payout_id = target_payout;
  IF linked_debit <> payout_debit OR linked_credit <> payout_credit THEN
    RAISE EXCEPTION 'Os lançamentos do fechamento de comissão não batem com os totais gravados nele.' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "account_manager_payout_adjustments_match" AFTER INSERT ON "account_manager_payout" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "crediai_manager_payout_adjustments_match"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "account_manager_adjustment_payout_match" AFTER INSERT OR UPDATE ON "account_manager_adjustment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "crediai_manager_payout_adjustments_match"();
