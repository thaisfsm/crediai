-- Clientes: empresa (nome e CNPJ) no endereço comercial, dados bancários e chave Pix, e o mesmo CPF uma só vez por carteira.
-- Só acrescenta colunas vazias, duas regras de formato e um índice; nenhuma linha existente é alterada.
ALTER TABLE "client" ADD COLUMN "business_company_name" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "business_cnpj" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "bank_holder_name" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "bank_holder_document" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "bank_branch" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "bank_account" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "bank_account_type" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "pix_key_type" text;--> statement-breakpoint
ALTER TABLE "client" ADD COLUMN "pix_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "client_tenant_document_unique" ON "client" USING btree ("tenant_id","document") WHERE "client"."document" is not null;--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_bank_account_type_valid" CHECK ("client"."bank_account_type" is null or "client"."bank_account_type" in ('CHECKING', 'SAVINGS', 'PAYMENT', 'SALARY'));--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_pix_key_pair" CHECK (("client"."pix_key" is null) = ("client"."pix_key_type" is null) and ("client"."pix_key_type" is null or "client"."pix_key_type" in ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM')));