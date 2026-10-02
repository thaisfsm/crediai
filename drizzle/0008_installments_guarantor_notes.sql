ALTER TABLE "client" ADD COLUMN "guarantor_notes" text;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD COLUMN "modality" text DEFAULT 'SINGLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD COLUMN "installment_count" integer;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD COLUMN "installment_cents" bigint;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD COLUMN "first_due_date" date;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD CONSTRAINT "loan_operation_modality_valid" CHECK (("loan_operation"."modality" = 'SINGLE' and "loan_operation"."installment_count" is null and "loan_operation"."installment_cents" is null and "loan_operation"."first_due_date" is null)
    or ("loan_operation"."modality" = 'INSTALLMENT' and "loan_operation"."installment_count" >= 1 and "loan_operation"."installment_cents" > 0 and "loan_operation"."first_due_date" is not null
      and "loan_operation"."total_cents" = "loan_operation"."installment_count" * "loan_operation"."installment_cents"));