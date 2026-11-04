CREATE TABLE "payment_reclassification" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"previous_mode" text,
	"previous_allocation_order" text,
	"previous_period_number" integer,
	"new_mode" text NOT NULL,
	"new_allocation_order" text,
	"new_period_number" integer,
	"reason" text NOT NULL,
	"authorized_by" text NOT NULL,
	"txid" bigint DEFAULT txid_current() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_reclassification_reason_not_blank" CHECK (length(trim("payment_reclassification"."reason")) >= 10)
);
--> statement-breakpoint
ALTER TABLE "payment_reclassification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "interest_period_number" integer;--> statement-breakpoint
ALTER TABLE "payment_reclassification" ADD CONSTRAINT "payment_reclassification_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reclassification" ADD CONSTRAINT "payment_reclassification_payment_same_tenant_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payment"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_reclassification_payment_idx" ON "payment_reclassification" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_interest_period_unique" ON "payment" USING btree ("operation_id","interest_period_number") WHERE "payment"."interest_period_number" is not null;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_interest_period_valid" CHECK ("payment"."interest_period_number" is null or ("payment"."interest_period_number" >= 1 and "payment"."payment_mode" = 'INTEREST_ONLY_RENEWAL'));--> statement-breakpoint
CREATE POLICY "payment_reclassification_select_tenant_or_admin" ON "payment_reclassification" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "payment_reclassification"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "payment_reclassification_insert_admin_only" ON "payment_reclassification" AS PERMISSIVE FOR INSERT TO public WITH CHECK (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');--> statement-breakpoint
CREATE POLICY "payment_reclassification_update_admin_only" ON "payment_reclassification" AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "payment_reclassification_delete_admin_only" ON "payment_reclassification" AS PERMISSIVE FOR DELETE TO public USING (false);--> statement-breakpoint
-- Modalidade, ordem de apropriação e período ficam travados depois de gravados. A única exceção é a reclassificação
-- autorizada: uma linha em payment_reclassification gravada NA MESMA TRANSAÇÃO (txid), para este pagamento, com o antes
-- igual ao gravado e o depois igual ao novo. Pagamentos antigos (null) podem ser preenchidos uma vez, como na 0054.
CREATE OR REPLACE FUNCTION "crediai_payment_mode_locked"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.payment_mode IS NOT NULL AND NEW.payment_mode IS DISTINCT FROM OLD.payment_mode)
     OR (OLD.allocation_order IS NOT NULL AND NEW.allocation_order IS DISTINCT FROM OLD.allocation_order)
     OR (OLD.interest_period_number IS DISTINCT FROM NEW.interest_period_number AND (OLD.payment_mode IS NOT NULL OR OLD.interest_period_number IS NOT NULL)) THEN
    IF NOT EXISTS (
      SELECT 1 FROM payment_reclassification r
       WHERE r.payment_id = NEW.id AND r.tenant_id = NEW.tenant_id AND r.txid = txid_current()
         AND r.previous_mode IS NOT DISTINCT FROM OLD.payment_mode AND r.previous_allocation_order IS NOT DISTINCT FROM OLD.allocation_order
         AND r.previous_period_number IS NOT DISTINCT FROM OLD.interest_period_number
         AND r.new_mode IS NOT DISTINCT FROM NEW.payment_mode AND r.new_allocation_order IS NOT DISTINCT FROM NEW.allocation_order
         AND r.new_period_number IS NOT DISTINCT FROM NEW.interest_period_number) THEN
      RAISE EXCEPTION 'Pagamento: a modalidade, a ordem de apropriação e o período gravados só mudam por reclassificação autorizada.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_mode_locked" ON "payment";--> statement-breakpoint
CREATE TRIGGER "payment_mode_locked" BEFORE UPDATE OF "payment_mode", "allocation_order", "interest_period_number" ON "payment"
  FOR EACH ROW EXECUTE FUNCTION "crediai_payment_mode_locked"();
--> statement-breakpoint
-- A reclassificação é um registro de auditoria: nunca se edita nem se apaga (vale também para o dono do banco).
CREATE OR REPLACE FUNCTION "crediai_payment_reclassification_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Reclassificação de pagamento é registro de auditoria: não pode ser alterada nem apagada.' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER "payment_reclassification_immutable" BEFORE UPDATE OR DELETE ON "payment_reclassification"
  FOR EACH ROW EXECUTE FUNCTION "crediai_payment_reclassification_immutable"();
