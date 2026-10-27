ALTER TABLE "credit_policy" ADD COLUMN "max_principal_lent_cents" bigint;--> statement-breakpoint
ALTER TABLE "credit_policy" ADD COLUMN "max_principal_review_on" date;--> statement-breakpoint
ALTER TABLE "credit_policy" ADD CONSTRAINT "credit_policy_max_principal_lent_valid" CHECK ("credit_policy"."max_principal_lent_cents" is null or "credit_policy"."max_principal_lent_cents" > 0);