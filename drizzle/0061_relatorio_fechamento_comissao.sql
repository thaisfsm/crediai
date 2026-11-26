CREATE TABLE "account_manager_payout_item" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"manager_id" text NOT NULL,
	"payout_id" text NOT NULL,
	"operation_id" text,
	"client_id" text,
	"client_name" text NOT NULL,
	"operation_code" text,
	"loan_date" date,
	"principal_cents" bigint NOT NULL,
	"interest_rate_bps" numeric(9, 1) NOT NULL,
	"commission_bps" integer NOT NULL,
	"interest_received_cents" bigint NOT NULL,
	"commission_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_manager_payout_item_values_valid" CHECK ("account_manager_payout_item"."commission_cents" > 0 and "account_manager_payout_item"."principal_cents" >= 0 and "account_manager_payout_item"."interest_received_cents" >= 0 and "account_manager_payout_item"."interest_rate_bps" >= 0 and "account_manager_payout_item"."commission_bps" >= 0 and "account_manager_payout_item"."commission_bps" <= 10000),
	CONSTRAINT "account_manager_payout_item_client_name_not_blank" CHECK (length(trim("account_manager_payout_item"."client_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "account_manager_payout_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_manager_payout_item" ADD CONSTRAINT "account_manager_payout_item_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_manager_payout_item" ADD CONSTRAINT "account_manager_payout_item_payout_same_manager_fk" FOREIGN KEY ("tenant_id","manager_id","payout_id") REFERENCES "public"."account_manager_payout"("tenant_id","manager_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_manager_payout_item_payout_idx" ON "account_manager_payout_item" USING btree ("tenant_id","payout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_manager_payout_item_operation_unique" ON "account_manager_payout_item" USING btree ("tenant_id","payout_id","operation_id");--> statement-breakpoint
CREATE POLICY "account_manager_payout_item_select_tenant_or_admin" ON "account_manager_payout_item" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_payout_item"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_payout_item_insert_own_or_admin" ON "account_manager_payout_item" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_payout_item"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_payout_item_update_own_or_admin" ON "account_manager_payout_item" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_payout_item"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "account_manager_payout_item"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "account_manager_payout_item_delete_admin_only" ON "account_manager_payout_item" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
-- Detalhamento gravado é histórico: não muda nem se apaga (a exclusão em cascata do tenant continua possível).
CREATE TRIGGER "account_manager_payout_item_append_only" BEFORE UPDATE OR DELETE ON "account_manager_payout_item" FOR EACH ROW EXECUTE FUNCTION "crediai_manager_payout_append_only"();--> statement-breakpoint
CREATE TRIGGER "account_manager_payout_item_no_truncate" BEFORE TRUNCATE ON "account_manager_payout_item" FOR EACH STATEMENT EXECUTE FUNCTION "crediai_manager_payout_append_only"();--> statement-breakpoint
-- As linhas só entram na MESMA transação que registrou o fechamento (nada se acrescenta a fechamento antigo) e, no fim da transação,
-- têm de somar exatamente a comissão gravada nele.
CREATE OR REPLACE FUNCTION "crediai_manager_payout_items_match"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payout_amount bigint; payout_created timestamptz; linked bigint;
BEGIN
  SELECT amount_cents, created_at INTO payout_amount, payout_created FROM "account_manager_payout" WHERE tenant_id = NEW.tenant_id AND id = NEW.payout_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF payout_created <> now() THEN
    RAISE EXCEPTION 'O detalhamento só pode ser gravado junto com o próprio fechamento de comissão.' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(sum(commission_cents), 0) INTO linked FROM "account_manager_payout_item" WHERE tenant_id = NEW.tenant_id AND payout_id = NEW.payout_id;
  IF linked <> payout_amount THEN
    RAISE EXCEPTION 'O detalhamento do fechamento de comissão não soma o valor gravado nele.' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "account_manager_payout_item_match" AFTER INSERT ON "account_manager_payout_item" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "crediai_manager_payout_items_match"();
