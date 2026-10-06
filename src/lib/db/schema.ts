import { sql, type SQLWrapper } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const roleSetting = sql`coalesce(current_setting('app.crediai_role', true), '')`;
const tenantSetting = sql`nullif(current_setting('app.tenant_id', true), '')`;
const tenantScope = (tenantId: SQLWrapper) => sql`(${roleSetting} = 'SUPER_ADMIN' or ${tenantId} = ${tenantSetting})`;
const adminScope = sql`${roleSetting} = 'SUPER_ADMIN'`;

// Conteúdo de arquivo guardado no próprio banco (bytea).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });


export const userRole = pgEnum("user_role", ["TENANT_USER", "SUPER_ADMIN"]);
export const tenantStatus = pgEnum("tenant_status", ["TRIALING", "ACTIVE", "SUSPENDED", "CLOSED"]);
export const loanOperationStatus = pgEnum("loan_operation_status", ["OPEN", "PAID", "CANCELED"]);
// Movimentos de capital além do capital inicial (que fica em wallet): aporte, retirada e estorno de aporte.
export const capitalMovementKind = pgEnum("capital_movement_kind", ["CONTRIBUTION", "WITHDRAWAL", "CONTRIBUTION_REVERSAL"]);
export const subscriptionStatus = pgEnum("subscription_status", ["TRIALING", "ACTIVE", "PAST_DUE", "SUSPENDED", "EXPIRED", "CANCELED"]);
// Condição comercial de uma assinatura: preço padrão do plano, preço personalizado ou cortesia (sem cobrança).
export const commercialCondition = pgEnum("commercial_condition", ["STANDARD", "CUSTOM", "COURTESY"]);
export const billingCycle = pgEnum("billing_cycle", ["MONTHLY"]);
// Mensalidades da assinatura. Hoje só o SUPER_ADMIN registra pagamentos (MANUAL); um provedor de cobrança futuro
// usa as mesmas linhas (PENDING ao gerar, PAID ao confirmar), guardando o identificador externo.
export const subscriptionChargeStatus = pgEnum("subscription_charge_status", ["PENDING", "PAID", "CANCELED", "FAILED"]);

export const plans = pgTable("plan", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull().default(""),
  // Preço PADRÃO do plano. O valor que cada cliente paga fica em subscription.contracted_price_cents.
  priceInCents: integer("price_in_cents").notNull().default(0),
  // Preparados para o futuro: recursos e limites do plano (ainda não aplicados pelo app).
  features: jsonb("features").$type<Record<string, unknown>>().notNull().default({}),
  limits: jsonb("limits").$type<Record<string, unknown>>().notNull().default({}),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  pgPolicy("plan_read_active_or_admin", { for: "select", using: sql`${table.active} = true or ${adminScope}` }),
  pgPolicy("plan_insert_admin_only", { for: "insert", withCheck: adminScope }),
  pgPolicy("plan_update_admin_only", { for: "update", using: adminScope, withCheck: adminScope }),
  pgPolicy("plan_delete_admin_only", { for: "delete", using: adminScope }),
]).enableRLS();

export const tenants = pgTable("tenant", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  status: tenantStatus("status").notNull().default("TRIALING"),
  planId: text("plan_id").notNull().references(() => plans.id, { onDelete: "restrict" }),
  // Telefone de contato do cliente SaaS, preenchido pela administração da plataforma.
  contactPhone: text("contact_phone"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("tenant_slug_unique").on(table.slug),
  pgPolicy("tenant_select_tenant_or_admin", { for: "select", using: tenantScope(table.id) }),
  pgPolicy("tenant_insert_own_or_admin", { for: "insert", withCheck: tenantScope(table.id) }),
  pgPolicy("tenant_update_own_or_admin", { for: "update", using: tenantScope(table.id), withCheck: tenantScope(table.id) }),
  pgPolicy("tenant_delete_admin_only", { for: "delete", using: adminScope }),
]).enableRLS();

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: userRole("role").notNull().default("TENANT_USER"),
  tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "restrict" }),
  active: boolean("active").notNull().default(true),
  // Senha provisória (criada ou redefinida pelo SUPER_ADMIN): o app só libera o uso depois da troca.
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("user_tenant_id_idx").on(table.tenantId)]);

export const sessions = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => [index("session_user_id_idx").on(table.userId)]);

export const accounts = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("account_user_id_idx").on(table.userId)]);

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("verification_identifier_idx").on(table.identifier)]);

export const subscriptions = pgTable("subscription", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull().references(() => plans.id, { onDelete: "restrict" }),
  status: subscriptionStatus("status").notNull().default("TRIALING"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  // Em teste: fim do período de teste. Assinatura ativa: vazio (o ciclo mensal usa next_due_date).
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // Condição comercial (preenchida na ativação). Vazia enquanto o cliente está em teste.
  contractedPriceCents: integer("contracted_price_cents"),
  commercialCondition: commercialCondition("commercial_condition"),
  activatedAt: date("activated_at", { mode: "string" }),
  firstDueDate: date("first_due_date", { mode: "string" }),
  nextDueDate: date("next_due_date", { mode: "string" }),
  billingCycle: billingCycle("billing_cycle").notNull().default("MONTHLY"),
  graceDays: integer("grace_days").notNull().default(5),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("subscription_tenant_id_idx").on(table.tenantId),
  check("subscription_contracted_price_check", sql`${table.contractedPriceCents} is null or ${table.contractedPriceCents} >= 0`),
  check("subscription_courtesy_free_check", sql`${table.commercialCondition} is distinct from 'COURTESY' or ${table.contractedPriceCents} = 0`),
  check("subscription_grace_days_check", sql`${table.graceDays} between 0 and 60`),
  pgPolicy("subscription_select_tenant_or_admin", { for: "select", using: tenantScope(table.tenantId) }),
  // A condição comercial é decidida pela administração: o próprio tenant só lê a assinatura.
  pgPolicy("subscription_insert_own_or_admin", { for: "insert", withCheck: adminScope }),
  pgPolicy("subscription_update_own_or_admin", { for: "update", using: adminScope, withCheck: adminScope }),
  pgPolicy("subscription_delete_admin_only", { for: "delete", using: adminScope }),
]).enableRLS();

export const subscriptionCharges = pgTable("subscription_charge", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  subscriptionId: text("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  // Mensalidade a que se refere (o vencimento do ciclo) e o valor cobrado, copiado do valor contratado.
  dueDate: date("due_date", { mode: "string" }).notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: subscriptionChargeStatus("status").notNull().default("PENDING"),
  paidAt: date("paid_at", { mode: "string" }),
  // MANUAL = registrado pelo SUPER_ADMIN; no futuro, o nome do provedor de cobrança.
  provider: text("provider").notNull().default("MANUAL"),
  providerReference: text("provider_reference"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("subscription_charge_subscription_idx").on(table.subscriptionId, table.dueDate),
  index("subscription_charge_tenant_idx").on(table.tenantId),
  check("subscription_charge_amount_check", sql`${table.amountCents} >= 0`),
  check("subscription_charge_paid_check", sql`(${table.status} = 'PAID') = (${table.paidAt} is not null)`),
  pgPolicy("subscription_charge_select_tenant_or_admin", { for: "select", using: tenantScope(table.tenantId) }),
  pgPolicy("subscription_charge_insert_admin_only", { for: "insert", withCheck: adminScope }),
  pgPolicy("subscription_charge_update_admin_only", { for: "update", using: adminScope, withCheck: adminScope }),
  pgPolicy("subscription_charge_delete_admin_only", { for: "delete", using: adminScope }),
]).enableRLS();

// Dados financeiros do tenant. Valores monetários em centavos; taxas em pontos-base (1% = 100).
// tenantDelete: o próprio tenant pode apagar (só usado em client, cuja FK RESTRICT impede apagar quem tem operações).
const tenantPolicies = (name: string, tenantId: SQLWrapper, { tenantDelete = false } = {}) => [
  pgPolicy(`${name}_select_tenant_or_admin`, { for: "select", using: tenantScope(tenantId) }),
  pgPolicy(`${name}_insert_own_or_admin`, { for: "insert", withCheck: tenantScope(tenantId) }),
  pgPolicy(`${name}_update_own_or_admin`, { for: "update", using: tenantScope(tenantId), withCheck: tenantScope(tenantId) }),
  tenantDelete
    ? pgPolicy(`${name}_delete_own_or_admin`, { for: "delete", using: tenantScope(tenantId) })
    : pgPolicy(`${name}_delete_admin_only`, { for: "delete", using: adminScope }),
];

export const wallets = pgTable("wallet", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  initialCapitalCents: bigint("initial_capital_cents", { mode: "number" }).notNull().default(0),
  // Ciclo financeiro atual. "Zerar carteira" fecha o ciclo e abre o seguinte; nada dos ciclos anteriores é apagado.
  cycleNumber: integer("cycle_number").notNull().default(1),
  // Início do ciclo atual; vazio no ciclo 1, que começa na criação da carteira.
  cycleStartedAt: timestamp("cycle_started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("wallet_tenant_id_unique").on(table.tenantId),
  check("wallet_initial_capital_non_negative", sql`${table.initialCapitalCents} >= 0`),
  check("wallet_cycle_number_positive", sql`${table.cycleNumber} >= 1`),
  ...tenantPolicies("wallet", table.tenantId),
]).enableRLS();

// Ciclos encerrados pelo "Zerar carteira": guarda o capital inicial e as datas de cada ciclo fechado.
export const walletCycles = pgTable("wallet_cycle", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  cycleNumber: integer("cycle_number").notNull(),
  initialCapitalCents: bigint("initial_capital_cents", { mode: "number" }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  closedByUserId: text("closed_by_user_id"),
}, (table) => [
  uniqueIndex("wallet_cycle_tenant_number_unique").on(table.tenantId, table.cycleNumber),
  check("wallet_cycle_cycle_number_positive", sql`${table.cycleNumber} >= 1`),
  ...tenantPolicies("wallet_cycle", table.tenantId),
]).enableRLS();

export const clients = pgTable("client", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  document: text("document"),
  phone: text("phone"),
  notes: text("notes"),
  // Endereço residencial
  residentialCep: text("residential_cep"),
  residentialStreet: text("residential_street"),
  residentialNumber: text("residential_number"),
  residentialComplement: text("residential_complement"),
  residentialDistrict: text("residential_district"),
  residentialCity: text("residential_city"),
  residentialState: text("residential_state"),
  // Endereço comercial
  businessCep: text("business_cep"),
  businessStreet: text("business_street"),
  businessNumber: text("business_number"),
  businessComplement: text("business_complement"),
  businessDistrict: text("business_district"),
  businessCity: text("business_city"),
  businessState: text("business_state"),
  // Duas referências pessoais
  reference1Name: text("reference1_name"),
  reference1Phone: text("reference1_phone"),
  reference1Relationship: text("reference1_relationship"),
  reference2Name: text("reference2_name"),
  reference2Phone: text("reference2_phone"),
  reference2Relationship: text("reference2_relationship"),
  // Avalista do cliente (vale para as operações dele)
  guarantorName: text("guarantor_name"),
  guarantorDocument: text("guarantor_document"),
  guarantorPhone: text("guarantor_phone"),
  guarantorNotes: text("guarantor_notes"),
  // Cliente com histórico de operações não é apagado: fica arquivado (fora da lista e do cadastro de operação).
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("client_tenant_id_idx").on(table.tenantId),
  unique("client_tenant_id_id_unique").on(table.tenantId, table.id),
  check("client_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ...tenantPolicies("client", table.tenantId, { tenantDelete: true }),
]).enableRLS();

export const loanOperations = pgTable("loan_operation", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  principalCents: bigint("principal_cents", { mode: "number" }).notNull(),
  interestRateBps: integer("interest_rate_bps").notNull(),
  interestCents: bigint("interest_cents", { mode: "number" }).notNull(),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  loanDate: date("loan_date", { mode: "string" }).notNull(),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  calculationRule: text("calculation_rule").notNull(),
  status: loanOperationStatus("status").notNull().default("OPEN"),
  settledAt: date("settled_at", { mode: "string" }),
  cycleNumber: integer("cycle_number").notNull().default(1),
  // Modalidade: SINGLE = pagamento único (com renovação pagando só os juros); INSTALLMENT = parcelado com parcela fixa (PMT).
  modality: text("modality").notNull().default("SINGLE"),
  // Só no parcelado: quantidade de parcelas, valor de cada parcela e primeiro vencimento (as demais vencem mês a mês).
  installmentCount: integer("installment_count"),
  installmentCents: bigint("installment_cents", { mode: "number" }),
  firstDueDate: date("first_due_date", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("loan_operation_tenant_id_idx").on(table.tenantId),
  index("loan_operation_tenant_cycle_idx").on(table.tenantId, table.cycleNumber),
  index("loan_operation_tenant_due_date_idx").on(table.tenantId, table.dueDate),
  unique("loan_operation_tenant_id_id_unique").on(table.tenantId, table.id),
  foreignKey({ name: "loan_operation_client_same_tenant_fk", columns: [table.tenantId, table.clientId], foreignColumns: [clients.tenantId, clients.id] }).onDelete("restrict"),
  check("loan_operation_principal_positive", sql`${table.principalCents} > 0`),
  check("loan_operation_rate_non_negative", sql`${table.interestRateBps} >= 0`),
  check("loan_operation_amounts_consistent", sql`${table.interestCents} >= 0 and ${table.totalCents} = ${table.principalCents} + ${table.interestCents}`),
  check("loan_operation_due_after_loan", sql`${table.dueDate} >= ${table.loanDate}`),
  check("loan_operation_modality_valid", sql`(${table.modality} = 'SINGLE' and ${table.installmentCount} is null and ${table.installmentCents} is null and ${table.firstDueDate} is null)
    or (${table.modality} = 'INSTALLMENT' and ${table.installmentCount} >= 1 and ${table.installmentCents} > 0 and ${table.firstDueDate} is not null
      and ${table.totalCents} = ${table.installmentCount} * ${table.installmentCents})`),
  ...tenantPolicies("loan_operation", table.tenantId),
]).enableRLS();

export const payments = pgTable("payment", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  operationId: text("operation_id").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  paidAt: date("paid_at", { mode: "string" }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("payment_tenant_id_idx").on(table.tenantId),
  index("payment_operation_id_idx").on(table.operationId),
  unique("payment_tenant_id_id_unique").on(table.tenantId, table.id),
  foreignKey({ name: "payment_operation_same_tenant_fk", columns: [table.tenantId, table.operationId], foreignColumns: [loanOperations.tenantId, loanOperations.id] }).onDelete("restrict"),
  check("payment_amount_positive", sql`${table.amountCents} > 0`),
  ...tenantPolicies("payment", table.tenantId),
]).enableRLS();

// Histórico de edições de pagamento: guarda valor, data e observação de antes e de depois de cada correção.
export const paymentRevisions = pgTable("payment_revision", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  paymentId: text("payment_id").notNull(),
  previousAmountCents: bigint("previous_amount_cents", { mode: "number" }).notNull(),
  previousPaidAt: date("previous_paid_at", { mode: "string" }).notNull(),
  previousNotes: text("previous_notes"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  paidAt: date("paid_at", { mode: "string" }).notNull(),
  notes: text("notes"),
  editedByUserId: text("edited_by_user_id"),
  editedAt: timestamp("edited_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("payment_revision_payment_id_idx").on(table.paymentId),
  foreignKey({ name: "payment_revision_payment_same_tenant_fk", columns: [table.tenantId, table.paymentId], foreignColumns: [payments.tenantId, payments.id] }).onDelete("restrict"),
  check("payment_revision_amounts_positive", sql`${table.previousAmountCents} > 0 and ${table.amountCents} > 0`),
  ...tenantPolicies("payment_revision", table.tenantId),
]).enableRLS();

// Renovação de período: o cliente pagou só os juros do período e a operação ganhou novo vencimento e novo período de juros.
// O pagamento dos juros fica em payment (entra no capital como qualquer pagamento); aqui fica o que a renovação mudou.
export const loanRenewals = pgTable("loan_renewal", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  operationId: text("operation_id").notNull(),
  paymentId: text("payment_id").notNull(),
  // Número do novo período (o período original é o 1; a primeira renovação abre o 2).
  periodNumber: integer("period_number").notNull(),
  previousDueDate: date("previous_due_date", { mode: "string" }).notNull(),
  newDueDate: date("new_due_date", { mode: "string" }).notNull(),
  // Principal em aberto na renovação e juros do novo período (taxa da operação sobre esse principal; sem juros sobre juros).
  principalBaseCents: bigint("principal_base_cents", { mode: "number" }).notNull(),
  interestCents: bigint("interest_cents", { mode: "number" }).notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("loan_renewal_operation_id_idx").on(table.operationId),
  uniqueIndex("loan_renewal_payment_unique").on(table.paymentId),
  uniqueIndex("loan_renewal_operation_period_unique").on(table.operationId, table.periodNumber),
  foreignKey({ name: "loan_renewal_operation_same_tenant_fk", columns: [table.tenantId, table.operationId], foreignColumns: [loanOperations.tenantId, loanOperations.id] }).onDelete("restrict"),
  foreignKey({ name: "loan_renewal_payment_same_tenant_fk", columns: [table.tenantId, table.paymentId], foreignColumns: [payments.tenantId, payments.id] }).onDelete("restrict"),
  check("loan_renewal_period_after_first", sql`${table.periodNumber} >= 2`),
  check("loan_renewal_due_extended", sql`${table.newDueDate} > ${table.previousDueDate}`),
  check("loan_renewal_amounts_valid", sql`${table.principalBaseCents} > 0 and ${table.interestCents} >= 0`),
  ...tenantPolicies("loan_renewal", table.tenantId),
]).enableRLS();

// Documentos anexados ao cliente. O arquivo fica no banco, sempre ligado a um cliente do mesmo tenant.
export const clientDocuments = pgTable("client_document", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  // O que é o documento (RG, comprovante de residência, contrato…)
  label: text("label").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  content: bytea("content").notNull(),
  uploadedByUserId: text("uploaded_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("client_document_client_id_idx").on(table.clientId),
  // Cliente apagado de vez (só quem nunca teve operação) leva os documentos junto; nenhum arquivo fica solto.
  foreignKey({ name: "client_document_client_same_tenant_fk", columns: [table.tenantId, table.clientId], foreignColumns: [clients.tenantId, clients.id] }).onDelete("cascade"),
  check("client_document_size_limit", sql`${table.sizeBytes} > 0 and ${table.sizeBytes} <= 5242880`),
  check("client_document_label_not_blank", sql`length(trim(${table.label})) > 0`),
  ...tenantPolicies("client_document", table.tenantId, { tenantDelete: true }),
]).enableRLS();

export const capitalMovements = pgTable("capital_movement", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  kind: capitalMovementKind("kind").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  occurredAt: date("occurred_at", { mode: "string" }).notNull(),
  notes: text("notes"),
  // Estorno aponta para o aporte estornado; o aporte original continua no histórico.
  reversedMovementId: text("reversed_movement_id"),
  cycleNumber: integer("cycle_number").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("capital_movement_tenant_id_idx").on(table.tenantId),
  index("capital_movement_tenant_cycle_idx").on(table.tenantId, table.cycleNumber),
  unique("capital_movement_tenant_id_id_unique").on(table.tenantId, table.id),
  uniqueIndex("capital_movement_reversed_movement_unique").on(table.reversedMovementId),
  foreignKey({ name: "capital_movement_reversal_same_tenant_fk", columns: [table.tenantId, table.reversedMovementId], foreignColumns: [table.tenantId, table.id] }).onDelete("restrict"),
  check("capital_movement_amount_positive", sql`${table.amountCents} > 0`),
  check("capital_movement_reversal_link", sql`(${table.kind}::text = 'CONTRIBUTION_REVERSAL') = (${table.reversedMovementId} is not null)`),
  ...tenantPolicies("capital_movement", table.tenantId),
]).enableRLS();

export const schema = { accounts, capitalMovements, clientDocuments, clients, loanOperations, loanRenewals, paymentRevisions, payments, plans, sessions, subscriptionCharges, subscriptions, tenants, users, verifications, walletCycles, wallets };
