-- Parcelado com valores combinados por parcela (ex.: 3 x R$ 922,00 e a 4a por R$ 411,00). Soma dos valores em centavos,
-- conferida contra o total do contrato. Devolve -1 (nunca nulo, para a verificacao nao passar por omissao) quando nao e um
-- array com um inteiro positivo por parcela. Operacoes existentes ficam com installment_amounts vazio e nao mudam.
CREATE OR REPLACE FUNCTION crediai_installment_amounts_total(amounts jsonb, expected_count integer) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN amounts IS NULL OR jsonb_typeof(amounts) <> 'array' OR expected_count IS NULL OR jsonb_array_length(amounts) <> expected_count THEN -1::bigint
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(amounts) AS item(value) WHERE jsonb_typeof(item.value) <> 'number' OR item.value::text !~ '^[1-9][0-9]{0,14}$') THEN -1::bigint
    ELSE (SELECT sum((item.value::text)::bigint)::bigint FROM jsonb_array_elements(amounts) AS item(value))
  END
$$;--> statement-breakpoint
ALTER TABLE "loan_operation" DROP CONSTRAINT "loan_operation_modality_valid";--> statement-breakpoint
ALTER TABLE "loan_operation" ADD COLUMN "installment_amounts" jsonb;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD CONSTRAINT "loan_operation_installment_amounts_valid" CHECK ("loan_operation"."installment_amounts" is null or ("loan_operation"."modality" = 'INSTALLMENT' and crediai_installment_amounts_total("loan_operation"."installment_amounts", "loan_operation"."installment_count") = "loan_operation"."total_cents"));--> statement-breakpoint
ALTER TABLE "loan_operation" ADD CONSTRAINT "loan_operation_modality_valid" CHECK (("loan_operation"."modality" = 'SINGLE' and "loan_operation"."frequency" in ('MONTHLY', 'BIWEEKLY') and "loan_operation"."installment_count" is null and "loan_operation"."installment_cents" is null)
    or ("loan_operation"."modality" = 'SINGLE' and "loan_operation"."frequency" = 'DAILY' and "loan_operation"."installment_count" >= 1 and "loan_operation"."installment_cents" > 0 and "loan_operation"."first_due_date" is not null
      and "loan_operation"."total_cents" >= "loan_operation"."installment_count" * "loan_operation"."installment_cents" and "loan_operation"."total_cents" < "loan_operation"."installment_count" * "loan_operation"."installment_cents" + "loan_operation"."installment_count")
    or ("loan_operation"."modality" = 'INSTALLMENT' and "loan_operation"."frequency" in ('MONTHLY', 'BIWEEKLY') and "loan_operation"."installment_count" >= 1 and "loan_operation"."installment_cents" > 0 and "loan_operation"."first_due_date" is not null
      and ("loan_operation"."installment_amounts" is not null or "loan_operation"."total_cents" >= "loan_operation"."installment_count" * "loan_operation"."installment_cents")));