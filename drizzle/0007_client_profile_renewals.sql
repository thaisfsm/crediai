CREATE TABLE "client_document" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"label" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"uploaded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_document_size_limit" CHECK ("client_document"."size_bytes" > 0 and "client_document"."size_bytes" <= 5242880),
	CONSTRAINT "client_document_label_not_blank" CHECK (length(trim("client_document"."label")) > 0)
);
--> statement-breakpoint
ALTER TABLE "client_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_document" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "loan_renewal" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"period_number" integer NOT NULL,
	"previous_due_date" date NOT NULL,
	"new_due_date" date NOT NULL,
	"principal_base_cents" bigint NOT NULL,
	"interest_cents" bigint NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_renewal_period_after_first" CHECK ("loan_renewal"."period_number" >= 2),
	CONSTRAINT "loan_renewal_due_extended" CHECK ("loan_renewal"."new_due_date" > "loan_renewal"."previous_due_date"),
	CONSTRAINT "loan_renewal_amounts_valid" CHECK ("loan_renewal"."principal_base_cents" > 0 and "loan_renewal"."interest_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "loan_renewal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loan_renewal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "residential_cep" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "residential_street" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "residential_number" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "residential_complement" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "residential_district" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "residential_city" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "residential_state" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "business_cep" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "business_street" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "business_number" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "business_complement" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "business_district" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "business_city" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "business_state" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "reference1_name" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "reference1_phone" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "reference1_relationship" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "reference2_name" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "reference2_phone" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "reference2_relationship" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "guarantor_name" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "guarantor_document" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "guarantor_phone" text;--> statement-breakpoint
ALTER TABLE "client_document" ADD CONSTRAINT "client_document_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_document" ADD CONSTRAINT "client_document_client_same_tenant_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."client"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_renewal" ADD CONSTRAINT "loan_renewal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_renewal" ADD CONSTRAINT "loan_renewal_operation_same_tenant_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."loan_operation"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_renewal" ADD CONSTRAINT "loan_renewal_payment_same_tenant_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payment"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_document_client_id_idx" ON "client_document" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "loan_renewal_operation_id_idx" ON "loan_renewal" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_renewal_payment_unique" ON "loan_renewal" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_renewal_operation_period_unique" ON "loan_renewal" USING btree ("operation_id","period_number");--> statement-breakpoint
CREATE POLICY "client_document_select_tenant_or_admin" ON "client_document" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "client_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "client_document_insert_own_or_admin" ON "client_document" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "client_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "client_document_update_own_or_admin" ON "client_document" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "client_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "client_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "client_document_delete_own_or_admin" ON "client_document" AS PERMISSIVE FOR DELETE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "client_document"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "loan_renewal_select_tenant_or_admin" ON "loan_renewal" AS PERMISSIVE FOR SELECT TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "loan_renewal"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "loan_renewal_insert_own_or_admin" ON "loan_renewal" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "loan_renewal"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "loan_renewal_update_own_or_admin" ON "loan_renewal" AS PERMISSIVE FOR UPDATE TO public USING ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "loan_renewal"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''))) WITH CHECK ((coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN' or "loan_renewal"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')));--> statement-breakpoint
CREATE POLICY "loan_renewal_delete_admin_only" ON "loan_renewal" AS PERMISSIVE FOR DELETE TO public USING (coalesce(current_setting('app.crediai_role', true), '') = 'SUPER_ADMIN');