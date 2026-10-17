ALTER TYPE "public"."loan_operation_status" ADD VALUE 'RENEGOTIATED';--> statement-breakpoint
ALTER TABLE "loan_operation" ADD COLUMN "renegotiated_into_id" text;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD COLUMN "renegotiated_on" date;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD COLUMN "renegotiated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD COLUMN "renegotiated_principal_cents" bigint;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD COLUMN "renegotiated_interest_cents" bigint;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD CONSTRAINT "loan_operation_renegotiated_into_fk" FOREIGN KEY ("tenant_id","renegotiated_into_id") REFERENCES "public"."loan_operation"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_operation" ADD CONSTRAINT "loan_operation_renegotiated_not_self" CHECK ("loan_operation"."renegotiated_into_id" is null or "loan_operation"."renegotiated_into_id" <> "loan_operation"."id");--> statement-breakpoint
ALTER TABLE "loan_operation" ADD CONSTRAINT "loan_operation_renegotiated_consistent" CHECK (("loan_operation"."status"::text = 'RENEGOTIATED') = ("loan_operation"."renegotiated_into_id" is not null and "loan_operation"."renegotiated_on" is not null and "loan_operation"."renegotiated_at" is not null and "loan_operation"."renegotiated_principal_cents" >= 0 and "loan_operation"."renegotiated_interest_cents" >= 0));