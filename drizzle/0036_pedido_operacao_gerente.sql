CREATE TABLE "operation_request" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"manager_id" text NOT NULL,
	"client_id" text NOT NULL,
	"form" jsonb NOT NULL,
	"principal_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"loan_date" date NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"decision_note" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"operation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operation_request_status_valid" CHECK ("operation_request"."status" in ('PENDING', 'APPROVED', 'REJECTED')),
	CONSTRAINT "operation_request_principal_positive" CHECK ("operation_request"."principal_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "operation_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "operation_request" ADD CONSTRAINT "operation_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_request" ADD CONSTRAINT "operation_request_manager_same_tenant_fk" FOREIGN KEY ("tenant_id","manager_id") REFERENCES "public"."account_manager"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_request" ADD CONSTRAINT "operation_request_client_same_tenant_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."client"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_request" ADD CONSTRAINT "operation_request_operation_same_tenant_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."loan_operation"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operation_request_tenant_status_idx" ON "operation_request" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "operation_request_manager_idx" ON "operation_request" USING btree ("tenant_id","manager_id");--> statement-breakpoint
CREATE POLICY "operation_request_select_tenant_or_admin" ON "operation_request" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "operation_request"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "operation_request_insert_own_or_admin" ON "operation_request" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "operation_request"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "operation_request_update_own_or_admin" ON "operation_request" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "operation_request"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "operation_request"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "operation_request_delete_admin_only" ON "operation_request" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');