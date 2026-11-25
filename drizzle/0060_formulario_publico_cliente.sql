ALTER TABLE "credit_proposal" ADD COLUMN "client_data" jsonb;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "client_data_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "fill_token" text;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "fill_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "fill_session_hash" text;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "fill_failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_proposal" ADD COLUMN "fill_locked_until" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_proposal_fill_token_unique" ON "credit_proposal" USING btree ("fill_token") WHERE "credit_proposal"."fill_token" is not null;