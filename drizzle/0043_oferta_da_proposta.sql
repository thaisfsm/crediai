ALTER TABLE "credit_proposal" ADD COLUMN "offer_cents" bigint;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "offer_term_months" integer;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "offer_rate_bps" numeric(9, 1);--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "offered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "offered_by_user_id" text;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD CONSTRAINT "credit_proposal_offer_valid" CHECK (("credit_proposal"."offer_cents" is null and "credit_proposal"."offer_term_months" is null and "credit_proposal"."offer_rate_bps" is null and "credit_proposal"."offered_at" is null) or ("credit_proposal"."offer_cents" > 0 and "credit_proposal"."offer_term_months" >= 1 and "credit_proposal"."offer_term_months" <= 360 and "credit_proposal"."offer_rate_bps" >= 0 and "credit_proposal"."offered_at" is not null));