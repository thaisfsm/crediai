ALTER TYPE "public"."capital_movement_kind" ADD VALUE 'WITHDRAWAL';--> statement-breakpoint
ALTER TYPE "public"."capital_movement_kind" ADD VALUE 'CONTRIBUTION_REVERSAL';--> statement-breakpoint
ALTER TABLE "capital_movement" ADD COLUMN "reversed_movement_id" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "capital_movement" ADD CONSTRAINT "capital_movement_tenant_id_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "capital_movement" ADD CONSTRAINT "capital_movement_reversal_same_tenant_fk" FOREIGN KEY ("tenant_id","reversed_movement_id") REFERENCES "public"."capital_movement"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capital_movement_reversed_movement_unique" ON "capital_movement" USING btree ("reversed_movement_id");--> statement-breakpoint
ALTER TABLE "capital_movement" ADD CONSTRAINT "capital_movement_reversal_link" CHECK (("capital_movement"."kind"::text = 'CONTRIBUTION_REVERSAL') = ("capital_movement"."reversed_movement_id" is not null));--> statement-breakpoint
DROP POLICY "client_delete_admin_only" ON "client" CASCADE;--> statement-breakpoint
CREATE POLICY "client_delete_own_or_admin" ON "client" AS PERMISSIVE FOR DELETE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "client"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));