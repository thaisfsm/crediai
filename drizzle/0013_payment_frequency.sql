-- Periodicidade do pagamento único (mensal, quinzenal, diário). Só estrutura: nenhuma operação, pagamento,
-- renovação ou carteira existente é alterada. As operações existentes recebem o padrão MONTHLY, que é o comportamento
-- que já tinham. A regra de modalidade passa a aceitar o quinzenal e o diário e a permitir que o pagamento único
-- guarde o primeiro vencimento combinado.
ALTER TABLE "loan_operation" DROP CONSTRAINT "loan_operation_modality_valid";--> statement-breakpoint
ALTER TABLE "loan_operation" ADD COLUMN "frequency" text DEFAULT 'MONTHLY' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD CONSTRAINT "loan_operation_modality_valid" CHECK (("loan_operation"."modality" = 'SINGLE' and "loan_operation"."frequency" in ('MONTHLY', 'BIWEEKLY') and "loan_operation"."installment_count" is null and "loan_operation"."installment_cents" is null)
    or ("loan_operation"."modality" = 'SINGLE' and "loan_operation"."frequency" = 'DAILY' and "loan_operation"."installment_count" >= 1 and "loan_operation"."installment_cents" > 0 and "loan_operation"."first_due_date" is not null
      and "loan_operation"."total_cents" >= "loan_operation"."installment_count" * "loan_operation"."installment_cents" and "loan_operation"."total_cents" < "loan_operation"."installment_count" * "loan_operation"."installment_cents" + "loan_operation"."installment_count")
    or ("loan_operation"."modality" = 'INSTALLMENT' and "loan_operation"."frequency" = 'MONTHLY' and "loan_operation"."installment_count" >= 1 and "loan_operation"."installment_cents" > 0 and "loan_operation"."first_due_date" is not null
      and "loan_operation"."total_cents" = "loan_operation"."installment_count" * "loan_operation"."installment_cents"));