ALTER TABLE "payment" ADD COLUMN "payment_mode" text;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "allocation_order" text;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_mode_valid" CHECK ("payment"."payment_mode" is null or "payment"."payment_mode" in ('INTEREST_ONLY_RENEWAL', 'MANUAL', 'PRINCIPAL_AMORTIZATION', 'FULL_SETTLEMENT', 'EARLY_SETTLEMENT'));--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_allocation_order_valid" CHECK ("payment"."allocation_order" is null or "payment"."allocation_order" in ('INTEREST_FIRST', 'PRINCIPAL_FIRST'));--> statement-breakpoint
-- Modalidade e ordem de apropriação são gravadas uma vez: depois de preenchidas, nenhum UPDATE as troca. Pagamentos
-- antigos (null) continuam como estão; a correção histórica autorizada pode preenchê-las uma única vez (null → valor).
CREATE OR REPLACE FUNCTION "crediai_payment_mode_locked"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.payment_mode IS NOT NULL AND NEW.payment_mode IS DISTINCT FROM OLD.payment_mode)
     OR (OLD.allocation_order IS NOT NULL AND NEW.allocation_order IS DISTINCT FROM OLD.allocation_order) THEN
    RAISE EXCEPTION 'Pagamento: a modalidade e a ordem de apropriação gravadas não podem ser alteradas.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "payment_mode_locked" BEFORE UPDATE OF "payment_mode", "allocation_order" ON "payment"
  FOR EACH ROW EXECUTE FUNCTION "crediai_payment_mode_locked"();
