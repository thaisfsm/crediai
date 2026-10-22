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
  numeric,
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
export const loanOperationStatus = pgEnum("loan_operation_status", ["OPEN", "PAID", "CANCELED", "RENEGOTIATED"]);
// Movimentos de capital além do capital inicial (que fica em wallet): aporte, retirada (toda saída manual de dinheiro,
// com a categoria do módulo Financeiro), estorno de aporte e outras entradas manuais. O sinal de cada tipo no capital
// disponível fica em src/lib/finance/cashflow.ts (INFLOW_KINDS); o valor gravado é sempre positivo.
export const capitalMovementKind = pgEnum("capital_movement_kind", ["CONTRIBUTION", "WITHDRAWAL", "CONTRIBUTION_REVERSAL", "OTHER_INCOME"]);
export const subscriptionStatus = pgEnum("subscription_status", ["TRIALING", "ACTIVE", "PAST_DUE", "SUSPENDED", "EXPIRED", "CANCELED"]);
// Condição comercial de uma assinatura: preço padrão do plano, preço personalizado ou cortesia (sem cobrança).
export const commercialCondition = pgEnum("commercial_condition", ["STANDARD", "CUSTOM", "COURTESY"]);
export const billingCycle = pgEnum("billing_cycle", ["MONTHLY"]);
// Mensalidades da assinatura. Hoje só o SUPER_ADMIN registra pagamentos (MANUAL); um provedor de cobrança futuro
// usa as mesmas linhas (PENDING ao gerar, PAID ao confirmar), guardando o identificador externo.
export const subscriptionChargeStatus = pgEnum("subscription_charge_status", ["PENDING", "PAID", "CANCELED", "FAILED"]);

// Investidores: quem coloca dinheiro na carteira por meio de um contrato de investimento. Nenhuma regra financeira do
// investimento (rendimento, capitalização, resgate, multa, renovação) está definida ainda: os contratos guardam só o
// que foi combinado (valor, taxa e o período da taxa, datas) e o status.
export const investorStatus = pgEnum("investor_status", ["ACTIVE", "INACTIVE"]);
export const investmentStatus = pgEnum("investment_status", ["PENDING_SIGNATURE", "ACTIVE", "CLOSED", "CANCELED"]);
// Período a que a taxa combinada se refere, escolhido explicitamente em cada contrato (o sistema não presume nenhum).
export const investmentRatePeriod = pgEnum("investment_rate_period", ["MONTHLY", "YEARLY", "CONTRACT_TERM", "OTHER"]);
// Tipos de documento do investimento. Novos tipos entram aqui (ALTER TYPE … ADD VALUE) sem mudar a tabela.
export const investmentDocumentKind = pgEnum("investment_document_kind", ["SIGNED_CONTRACT", "ADDENDUM", "TRANSFER_RECEIPT", "OTHER"]);

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
  // Contatos e redes sociais (opcionais). Instagram/Facebook guardam @usuário ou o endereço do perfil, como digitado.
  whatsapp: text("whatsapp"),
  email: text("email"),
  instagram: text("instagram"),
  facebook: text("facebook"),
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
  // Empresa do endereço comercial: nome e CNPJ (só dígitos, com dígitos verificadores conferidos; pode repetir entre clientes).
  businessCompanyName: text("business_company_name"),
  businessCnpj: text("business_cnpj"),
  // Data em que o cliente começou no emprego (opcional; não pode ser futura).
  businessAdmissionDate: date("business_admission_date", { mode: "string" }),
  // Marcação manual: apostadora de cassino online. Vai pesar no score de concessão de crédito quando o score existir.
  onlineCasinoBettor: boolean("online_casino_bettor").notNull().default(false),
  // Dados bancários e chave Pix (opcionais). Regras em src/lib/bank-account.ts.
  bankHolderName: text("bank_holder_name"),
  bankHolderDocument: text("bank_holder_document"),
  bankName: text("bank_name"),
  bankBranch: text("bank_branch"),
  bankAccount: text("bank_account"),
  bankAccountType: text("bank_account_type"),
  pixKeyType: text("pix_key_type"),
  pixKey: text("pix_key"),
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
  // O mesmo CPF não aparece duas vezes na mesma carteira (clientes arquivados contam). Outras carteiras não são afetadas.
  uniqueIndex("client_tenant_document_unique").on(table.tenantId, table.document).where(sql`${table.document} is not null`),
  check("client_bank_account_type_valid", sql`${table.bankAccountType} is null or ${table.bankAccountType} in ('CHECKING', 'SAVINGS', 'PAYMENT', 'SALARY')`),
  check("client_pix_key_pair", sql`(${table.pixKey} is null) = (${table.pixKeyType} is null) and (${table.pixKeyType} is null or ${table.pixKeyType} in ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM'))`),
  ...tenantPolicies("client", table.tenantId, { tenantDelete: true }),
]).enableRLS();

export const loanOperations = pgTable("loan_operation", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  principalCents: bigint("principal_cents", { mode: "number" }).notNull(),
  // Pontos-base com uma casa decimal (1% = 100): permite taxas com 3 casas, como 14,995% (= 1499,5). Migração 0027.
  interestRateBps: numeric("interest_rate_bps", { precision: 9, scale: 1, mode: "number" }).notNull(),
  interestCents: bigint("interest_cents", { mode: "number" }).notNull(),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  loanDate: date("loan_date", { mode: "string" }).notNull(),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  calculationRule: text("calculation_rule").notNull(),
  status: loanOperationStatus("status").notNull().default("OPEN"),
  settledAt: date("settled_at", { mode: "string" }),
  cycleNumber: integer("cycle_number").notNull().default(1),
  // Renegociação: operação encerrada como RENEGOTIATED aponta para o contrato novo e guarda o que foi levado para ele
  // (principal e juros em aberto na data). Os pagamentos e renovações dela não mudam.
  renegotiatedIntoId: text("renegotiated_into_id"),
  renegotiatedOn: date("renegotiated_on", { mode: "string" }),
  renegotiatedAt: timestamp("renegotiated_at", { withTimezone: true }),
  renegotiatedPrincipalCents: bigint("renegotiated_principal_cents", { mode: "number" }),
  renegotiatedInterestCents: bigint("renegotiated_interest_cents", { mode: "number" }),
  // Liquidação antecipada: pagamento final negociado (um registro em payment, que entra no capital como qualquer outro), o
  // saldo que a operação tinha antes dela e o desconto (juros que não serão cobrados). Os pagamentos anteriores e os termos
  // do contrato não mudam. Sem chave estrangeira para payment (referência circular no schema); a ação grava os dois juntos. Migração 0029.
  settlementPaymentId: text("settlement_payment_id"),
  settlementBalanceCents: bigint("settlement_balance_cents", { mode: "number" }),
  settlementDiscountCents: bigint("settlement_discount_cents", { mode: "number" }),
  settlementByUserId: text("settlement_by_user_id"),
  // Modalidade: SINGLE = pagamento único (com renovação pagando só os juros); INSTALLMENT = parcelado com parcela fixa (juros simples).
  modality: text("modality").notNull().default("SINGLE"),
  // Periodicidade do pagamento único: MONTHLY e BIWEEKLY (juros recorrentes sobre o principal em aberto) ou DAILY
  // (total dividido em pagamentos diários). O parcelado é MONTHLY ou BIWEEKLY (parcelas quinzenais). Regras em src/lib/finance/rules.ts.
  frequency: text("frequency").notNull().default("MONTHLY"),
  // Parcelado e diário: quantidade de parcelas, valor de cada parcela (no diário a última leva o ajuste de centavos) e
  // primeiro vencimento. Pagamento único mensal/quinzenal: first_due_date guarda o primeiro vencimento combinado
  // (vazio nas operações antigas, em que ele é o vencimento original).
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
  foreignKey({ name: "loan_operation_renegotiated_into_fk", columns: [table.tenantId, table.renegotiatedIntoId], foreignColumns: [table.tenantId, table.id] }).onDelete("restrict"),
  check("loan_operation_settlement_consistent", sql`(${table.settlementPaymentId} is null) = (${table.settlementBalanceCents} is null) and (${table.settlementPaymentId} is null) = (${table.settlementDiscountCents} is null) and (${table.settlementPaymentId} is null or (${table.status}::text = 'PAID' and ${table.settlementDiscountCents} >= 0 and ${table.settlementBalanceCents} > 0))`),
  check("loan_operation_renegotiated_not_self", sql`${table.renegotiatedIntoId} is null or ${table.renegotiatedIntoId} <> ${table.id}`),
  check("loan_operation_renegotiated_consistent", sql`(${table.status}::text = 'RENEGOTIATED') = (${table.renegotiatedIntoId} is not null and ${table.renegotiatedOn} is not null and ${table.renegotiatedAt} is not null and ${table.renegotiatedPrincipalCents} >= 0 and ${table.renegotiatedInterestCents} >= 0)`),
  check("loan_operation_principal_positive", sql`${table.principalCents} > 0`),
  check("loan_operation_rate_non_negative", sql`${table.interestRateBps} >= 0`),
  check("loan_operation_amounts_consistent", sql`${table.interestCents} >= 0 and ${table.totalCents} = ${table.principalCents} + ${table.interestCents}`),
  check("loan_operation_due_after_loan", sql`${table.dueDate} >= ${table.loanDate}`),
  check("loan_operation_modality_valid", sql`(${table.modality} = 'SINGLE' and ${table.frequency} in ('MONTHLY', 'BIWEEKLY') and ${table.installmentCount} is null and ${table.installmentCents} is null)
    or (${table.modality} = 'SINGLE' and ${table.frequency} = 'DAILY' and ${table.installmentCount} >= 1 and ${table.installmentCents} > 0 and ${table.firstDueDate} is not null
      and ${table.totalCents} >= ${table.installmentCount} * ${table.installmentCents} and ${table.totalCents} < ${table.installmentCount} * ${table.installmentCents} + ${table.installmentCount})
    or (${table.modality} = 'INSTALLMENT' and ${table.frequency} in ('MONTHLY', 'BIWEEKLY') and ${table.installmentCount} >= 1 and ${table.installmentCents} > 0 and ${table.firstDueDate} is not null
      and ${table.totalCents} >= ${table.installmentCount} * ${table.installmentCents})`),
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

// Correções de operação (Etapa G, parte 1): só operações em aberto, sem pagamentos e sem renovações. Cada correção guarda o
// motivo, os campos alterados (antes e depois, como texto para leitura) e as colunas completas antes e depois. Não se edita
// nem se apaga pelo tenant.
export const loanOperationRevisions = pgTable("loan_operation_revision", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  operationId: text("operation_id").notNull(),
  reason: text("reason").notNull(),
  changes: jsonb("changes").$type<{ field: string; before: string | null; after: string | null }[]>().notNull(),
  before: jsonb("before").$type<Record<string, unknown>>().notNull(),
  after: jsonb("after").$type<Record<string, unknown>>().notNull(),
  editedByUserId: text("edited_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("loan_operation_revision_operation_idx").on(table.operationId, table.createdAt),
  foreignKey({ name: "loan_operation_revision_operation_same_tenant_fk", columns: [table.tenantId, table.operationId], foreignColumns: [loanOperations.tenantId, loanOperations.id] }).onDelete("restrict"),
  check("loan_operation_revision_reason_not_blank", sql`length(trim(${table.reason})) >= 3`),
  pgPolicy("loan_operation_revision_select_tenant_or_admin", { for: "select", using: tenantScope(table.tenantId) }),
  pgPolicy("loan_operation_revision_insert_own_or_admin", { for: "insert", withCheck: tenantScope(table.tenantId) }),
  pgPolicy("loan_operation_revision_update_admin_only", { for: "update", using: adminScope, withCheck: adminScope }),
  pgPolicy("loan_operation_revision_delete_admin_only", { for: "delete", using: adminScope }),
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

// Parcela renegociada para o final (empréstimo parcelado). A parcela original continua no histórico, com número, vencimento e
// valor originais, e deixa de ser cobrada no lugar; a nova obrigação (valor original + acréscimo) vence ao fim do cronograma.
// Não é pagamento, recebimento nem lucro: o acréscimo só vira juros recebidos quando for pago. Cálculo em rules.ts (ledger).
export const installmentDeferrals = pgTable("installment_deferral", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  operationId: text("operation_id").notNull(),
  // Número histórico da parcela (1..N do contrato original), seu vencimento e valor originais.
  originalNumber: integer("original_number").notNull(),
  originalDueDate: date("original_due_date", { mode: "string" }).notNull(),
  originalAmountCents: bigint("original_amount_cents", { mode: "number" }).notNull(),
  // Acréscimo ou multa negociada, a nova data e o novo valor (original + acréscimo) da obrigação no final.
  additionCents: bigint("addition_cents", { mode: "number" }).notNull().default(0),
  newDueDate: date("new_due_date", { mode: "string" }).notNull(),
  newAmountCents: bigint("new_amount_cents", { mode: "number" }).notNull(),
  // Motivo opcional (auditoria), separado da configuração financeira.
  reason: text("reason"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("installment_deferral_operation_id_idx").on(table.operationId),
  uniqueIndex("installment_deferral_operation_number_unique").on(table.operationId, table.originalNumber),
  foreignKey({ name: "installment_deferral_operation_same_tenant_fk", columns: [table.tenantId, table.operationId], foreignColumns: [loanOperations.tenantId, loanOperations.id] }).onDelete("restrict"),
  check("installment_deferral_valid", sql`${table.originalNumber} >= 1 and ${table.originalAmountCents} > 0 and ${table.additionCents} >= 0 and ${table.newAmountCents} = ${table.originalAmountCents} + ${table.additionCents} and ${table.newDueDate} > ${table.originalDueDate}`),
  ...tenantPolicies("installment_deferral", table.tenantId),
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
  // Módulo Financeiro: categoria (coerente com o tipo), descrição obrigatória, quem lançou, de que tela veio e a chave
  // que impede gravar o mesmo envio duas vezes. Linhas antigas (tela Capital) ficam sem categoria e com origem CAPITAL.
  category: text("category"),
  description: text("description"),
  createdByUserId: text("created_by_user_id"),
  source: text("source").notNull().default("CAPITAL"),
  idempotencyKey: text("idempotency_key"),
}, (table) => [
  index("capital_movement_tenant_id_idx").on(table.tenantId),
  index("capital_movement_tenant_cycle_idx").on(table.tenantId, table.cycleNumber),
  unique("capital_movement_tenant_id_id_unique").on(table.tenantId, table.id),
  uniqueIndex("capital_movement_reversed_movement_unique").on(table.reversedMovementId),
  foreignKey({ name: "capital_movement_reversal_same_tenant_fk", columns: [table.tenantId, table.reversedMovementId], foreignColumns: [table.tenantId, table.id] }).onDelete("restrict"),
  check("capital_movement_amount_positive", sql`${table.amountCents} > 0`),
  check("capital_movement_reversal_link", sql`(${table.kind}::text = 'CONTRIBUTION_REVERSAL') = (${table.reversedMovementId} is not null)`),
  uniqueIndex("capital_movement_tenant_idempotency_unique").on(table.tenantId, table.idempotencyKey).where(sql`${table.idempotencyKey} is not null`),
  // Origem: tela Capital, Financeiro ou Contas a Pagar / entrada de investimento (INVESTOR, migração 0022).
  check("capital_movement_source_valid", sql`${table.source} in ('CAPITAL', 'FINANCE', 'INVESTOR')`),
  // Categoria só com o tipo certo: entradas (aporte, entrada de investidor e outras entradas) e saídas (retiradas,
  // rendimento pago e devolução de principal a investidor). Outras entradas sempre têm categoria.
  check("capital_movement_category_matches_kind", sql`(${table.category} is null and ${table.kind}::text <> 'OTHER_INCOME')
    or (${table.kind}::text = 'CONTRIBUTION' and ${table.category} in ('CAPITAL_CONTRIBUTION', 'INVESTOR_CONTRIBUTION'))
    or (${table.kind}::text = 'OTHER_INCOME' and ${table.category} = 'OTHER_INCOME')
    or (${table.kind}::text = 'WITHDRAWAL' and ${table.category} in ('SALARY_WITHDRAWAL', 'PARTNER_WITHDRAWAL', 'OPERATING_EXPENSE', 'TAXES_AND_FEES', 'OTHER_OUTFLOW', 'INVESTOR_YIELD_PAYMENT', 'INVESTOR_PRINCIPAL_RETURN'))`),
  // Lançamento do Financeiro: sempre com categoria, descrição e a chave contra envio duplicado.
  check("capital_movement_finance_fields", sql`${table.source} <> 'FINANCE' or (${table.category} is not null and length(trim(coalesce(${table.description}, ''))) > 0 and ${table.idempotencyKey} is not null)`),
  // As categorias de investidor só existem com a origem INVESTOR (e vice-versa), sempre com descrição e chave.
  check("capital_movement_investor_fields", sql`(${table.source} = 'INVESTOR') = (coalesce(${table.category}, '') in ('INVESTOR_CONTRIBUTION', 'INVESTOR_YIELD_PAYMENT', 'INVESTOR_PRINCIPAL_RETURN'))
    and (${table.source} <> 'INVESTOR' or (length(trim(coalesce(${table.description}, ''))) > 0 and ${table.idempotencyKey} is not null))`),
  ...tenantPolicies("capital_movement", table.tenantId),
]).enableRLS();

// Investidor do tenant (pessoa física ou jurídica). Não há cadastro público: só usuários do tenant e o SUPER_ADMIN criam.
export const investors = pgTable("investor", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  // Nome ou razão social.
  name: text("name").notNull(),
  // CPF (11) ou CNPJ (14), só dígitos.
  document: text("document"),
  phone: text("phone"),
  whatsapp: text("whatsapp"),
  email: text("email"),
  // @usuário ou endereço do perfil, como digitado.
  instagram: text("instagram"),
  facebook: text("facebook"),
  notes: text("notes"),
  // Endereço (opcional no cadastro; obrigatório para gerar o contrato de investimento).
  addressCep: text("address_cep"),
  addressStreet: text("address_street"),
  addressNumber: text("address_number"),
  addressComplement: text("address_complement"),
  addressDistrict: text("address_district"),
  addressCity: text("address_city"),
  addressState: text("address_state"),
  // Dados bancários e chave Pix para os pagamentos ao investidor (opcionais). Regras em src/lib/bank-account.ts.
  bankHolderName: text("bank_holder_name"),
  bankHolderDocument: text("bank_holder_document"),
  bankName: text("bank_name"),
  bankBranch: text("bank_branch"),
  bankAccount: text("bank_account"),
  bankAccountType: text("bank_account_type"),
  pixKeyType: text("pix_key_type"),
  pixKey: text("pix_key"),
  status: investorStatus("status").notNull().default("ACTIVE"),
  // Migração 0024: tipo de pessoa (PF/PJ), nome fantasia (PJ) e data de nascimento (PF) ou de abertura (PJ). NULL no
  // tipo = investidor cadastrado antes da 0024 (nada foi preenchido por suposição); toda gravação nova exige o tipo.
  personType: text("person_type"),
  tradeName: text("trade_name"),
  birthDate: date("birth_date", { mode: "string" }),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("investor_person_type_valid", sql`${table.personType} is null or ${table.personType} in ('PF', 'PJ')`),
  // CPF (11 dígitos) só para PF e CNPJ (14) só para PJ.
  check("investor_person_type_document", sql`${table.personType} is null or ${table.document} is null or (${table.personType} = 'PF' and length(${table.document}) = 11) or (${table.personType} = 'PJ' and length(${table.document}) = 14)`),
  index("investor_tenant_id_idx").on(table.tenantId),
  unique("investor_tenant_id_id_unique").on(table.tenantId, table.id),
  // O mesmo CPF/CNPJ não aparece duas vezes na mesma carteira.
  uniqueIndex("investor_tenant_document_unique").on(table.tenantId, table.document).where(sql`${table.document} is not null`),
  check("investor_name_not_blank", sql`length(trim(${table.name})) > 0`),
  check("investor_bank_account_type_valid", sql`${table.bankAccountType} is null or ${table.bankAccountType} in ('CHECKING', 'SAVINGS', 'PAYMENT', 'SALARY')`),
  check("investor_pix_key_pair", sql`(${table.pixKey} is null) = (${table.pixKeyType} is null) and (${table.pixKeyType} is null or ${table.pixKeyType} in ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM'))`),
  ...tenantPolicies("investor", table.tenantId),
]).enableRLS();

// Contas bancárias do investidor para os pagamentos (migração 0024): várias por investidor, no máximo uma preferencial.
// Cada conta tem os dados de banco (código e/ou nome, agência, conta, dígitos, tipo) e/ou uma chave Pix: o que não se
// aplica fica vazio. Nunca entram na auditoria nem em logs; a ficha mostra a conta e a chave mascaradas. Retirar uma
// conta não apaga: ela fica arquivada (archived_at), e a conta ligada a um contrato não pode ser arquivada.
export const investorBankAccounts = pgTable("investor_bank_account", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  investorId: text("investor_id").notNull(),
  bankCode: text("bank_code"),
  bankName: text("bank_name"),
  branch: text("branch"),
  branchDigit: text("branch_digit"),
  account: text("account"),
  accountDigit: text("account_digit"),
  accountType: text("account_type"),
  holderName: text("holder_name"),
  holderDocument: text("holder_document"),
  pixKeyType: text("pix_key_type"),
  pixKey: text("pix_key"),
  isPreferred: boolean("is_preferred").notNull().default(false),
  notes: text("notes"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("investor_bank_account_investor_idx").on(table.tenantId, table.investorId),
  unique("investor_bank_account_tenant_investor_id_unique").on(table.tenantId, table.investorId, table.id),
  uniqueIndex("investor_bank_account_preferred_unique").on(table.investorId).where(sql`${table.isPreferred} and ${table.archivedAt} is null`),
  foreignKey({ name: "investor_bank_account_investor_same_tenant_fk", columns: [table.tenantId, table.investorId], foreignColumns: [investors.tenantId, investors.id] }).onDelete("restrict"),
  check("investor_bank_account_code_valid", sql`${table.bankCode} is null or ${table.bankCode} ~ '^[0-9]{3}$'`),
  check("investor_bank_account_branch_valid", sql`${table.branch} is null or ${table.branch} ~ '^[0-9]{1,5}$'`),
  check("investor_bank_account_digits_valid", sql`(${table.branchDigit} is null or ${table.branchDigit} ~ '^[0-9X]$') and (${table.accountDigit} is null or ${table.accountDigit} ~ '^[0-9X]$')`),
  check("investor_bank_account_account_valid", sql`${table.account} is null or ${table.account} ~ '^[0-9]{1,20}$'`),
  check("investor_bank_account_type_valid", sql`${table.accountType} is null or ${table.accountType} in ('CHECKING', 'SAVINGS', 'PAYMENT', 'SALARY')`),
  check("investor_bank_account_pix_pair", sql`(${table.pixKey} is null) = (${table.pixKeyType} is null) and (${table.pixKeyType} is null or ${table.pixKeyType} in ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM'))`),
  // Conta bancária completa (banco, agência e conta) ou chave Pix: pelo menos um dos dois.
  check("investor_bank_account_has_destination", sql`(${table.branch} is not null and ${table.account} is not null and (${table.bankCode} is not null or ${table.bankName} is not null)) or ${table.pixKey} is not null`),
  check("investor_bank_account_preferred_active", sql`not (${table.isPreferred} and ${table.archivedAt} is not null)`),
  ...tenantPolicies("investor_bank_account", table.tenantId),
]).enableRLS();

// Documentos do INVESTIDOR (identidade, comprovante de endereço, contrato social…), separados dos documentos de cada
// investimento. O arquivo fica no banco. Retirar não apaga: removed_at guarda quando, e o arquivo continua no histórico.
export const investorDocuments = pgTable("investor_document", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  investorId: text("investor_id").notNull(),
  kind: text("kind").notNull(),
  label: text("label"),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  content: bytea("content").notNull(),
  uploadedByUserId: text("uploaded_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  removedByUserId: text("removed_by_user_id"),
}, (table) => [
  index("investor_document_investor_idx").on(table.tenantId, table.investorId),
  foreignKey({ name: "investor_document_investor_same_tenant_fk", columns: [table.tenantId, table.investorId], foreignColumns: [investors.tenantId, investors.id] }).onDelete("restrict"),
  check("investor_document_kind_valid", sql`${table.kind} in ('IDENTITY', 'PROOF_OF_ADDRESS', 'COMPANY_RECORDS', 'BANK_PROOF', 'OTHER')`),
  check("investor_document_size_limit", sql`${table.sizeBytes} > 0 and ${table.sizeBytes} <= 5242880`),
  check("investor_document_removed_link", sql`(${table.removedAt} is null) = (${table.removedByUserId} is null)`),
  ...tenantPolicies("investor_document", table.tenantId),
]).enableRLS();

// Contrato de investimento: um investidor pode ter vários. Guarda só o combinado; os cálculos (rendimento, saldo, total
// a devolver, vencimentos de rendimento, renovação, resgate) dependem de regras ainda não definidas. calculation_rule
// fica vazio até lá, e as tabelas futuras (pagamentos de rendimento, resgates, renovações) se ligam por (tenant_id, id).
export const investments = pgTable("investment", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  investorId: text("investor_id").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  // Taxa combinada em pontos-base (1% = 100) e o período a que ela se refere. Nenhum cálculo usa estes campos ainda.
  agreedRateBps: integer("agreed_rate_bps").notNull(),
  ratePeriod: investmentRatePeriod("rate_period").notNull(),
  startDate: date("start_date", { mode: "string" }).notNull(),
  // Vencimento do contrato e, se combinado, o dia do mês de vencimento. Informativos: não geram cobranças nem rendimentos.
  maturityDate: date("maturity_date", { mode: "string" }),
  dueDay: integer("due_day"),
  // Identificação do contrato (opcional, única na carteira), data em que o dinheiro foi investido, prazo em meses,
  // periodicidade combinada dos pagamentos e quantidade de parcelas. Todos informados pelo usuário; nada é calculado.
  contractNumber: text("contract_number"),
  investedOn: date("invested_on", { mode: "string" }),
  termMonths: integer("term_months"),
  paymentFrequency: text("payment_frequency"),
  installmentCount: integer("installment_count"),
  notes: text("notes"),
  status: investmentStatus("status").notNull().default("ACTIVE"),
  calculationRule: text("calculation_rule"),
  // Migração 0024: data da contratação, prazo com a unidade (dias, meses ou anos; term_months fica só nos contratos
  // gravados antes), forma de pagamento ao investidor, conta bancária do próprio investidor para os pagamentos e as
  // condições combinadas de rendimento e de devolução do principal (texto do contrato; nada é calculado com elas).
  contractedOn: date("contracted_on", { mode: "string" }),
  termCount: integer("term_count"),
  termUnit: text("term_unit"),
  paymentMethod: text("payment_method"),
  bankAccountId: text("bank_account_id"),
  yieldTerms: text("yield_terms"),
  principalTerms: text("principal_terms"),
  // Migração 0026: liquidez (quando o investidor pode resgatar o crédito: ao término do contrato ou D+N dias depois dele)
  // e o valor do rendimento de cada pagamento, digitado por quem contratou. Nada é calculado com eles.
  redemptionRule: text("redemption_rule"),
  redemptionDays: integer("redemption_days"),
  yieldPaymentCents: bigint("yield_payment_cents", { mode: "number" }),
  // Renovação (migração 0024): o contrato novo aponta para o anterior. O principal ainda não devolvido do anterior passa
  // para o novo sem nova entrada no capital; o anterior fica encerrado com todo o histórico. Uma renovação por contrato.
  renewedFromInvestmentId: text("renewed_from_investment_id"),
  // Regra da entrada no capital (migração 0023). 'REQUIRED': contrato cadastrado com a regra; a baixa só passa com a
  // entrada do contrato registrada. NULL: contrato que já existia quando a migração 0023 rodou (a coluna nasceu vazia,
  // sem backfill); a baixa passa com a entrada OU com o aporte anterior indicado pelo usuário (investment_prior_contribution).
  // Um gatilho grava 'REQUIRED' em todo contrato novo (mesmo que alguém mande NULL) e impede mudar o valor depois.
  capitalEntryRule: text("capital_entry_rule"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("investment_capital_entry_rule_valid", sql`${table.capitalEntryRule} is null or ${table.capitalEntryRule} = 'REQUIRED'`),
  index("investment_tenant_id_idx").on(table.tenantId),
  index("investment_investor_id_idx").on(table.investorId),
  unique("investment_tenant_id_id_unique").on(table.tenantId, table.id),
  foreignKey({ name: "investment_investor_same_tenant_fk", columns: [table.tenantId, table.investorId], foreignColumns: [investors.tenantId, investors.id] }).onDelete("restrict"),
  check("investment_amount_positive", sql`${table.amountCents} > 0`),
  check("investment_rate_not_negative", sql`${table.agreedRateBps} >= 0`),
  check("investment_maturity_after_start", sql`${table.maturityDate} is null or ${table.maturityDate} >= ${table.startDate}`),
  check("investment_due_day_valid", sql`${table.dueDay} is null or ${table.dueDay} between 1 and 31`),
  uniqueIndex("investment_tenant_contract_number_unique").on(table.tenantId, table.contractNumber).where(sql`${table.contractNumber} is not null`),
  check("investment_term_months_valid", sql`${table.termMonths} is null or ${table.termMonths} between 1 and 600`),
  check("investment_installment_count_valid", sql`${table.installmentCount} is null or ${table.installmentCount} between 1 and 600`),
  check("investment_payment_frequency_valid", sql`${table.paymentFrequency} is null or ${table.paymentFrequency} in ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'YEARLY', 'AT_MATURITY', 'OTHER')`),
  check("investment_term_pair", sql`(${table.termCount} is null) = (${table.termUnit} is null) and (${table.termUnit} is null or ${table.termUnit} in ('DAYS', 'MONTHS', 'YEARS'))`),
  check("investment_term_count_valid", sql`${table.termCount} is null or ${table.termCount} between 1 and 18250`),
  check("investment_redemption_valid", sql`(${table.redemptionRule} is null and ${table.redemptionDays} is null) or (${table.redemptionRule} = 'AT_MATURITY' and ${table.redemptionDays} is null) or (${table.redemptionRule} = 'D_PLUS' and ${table.redemptionDays} between 1 and 3650)`),
  check("investment_yield_payment_valid", sql`${table.yieldPaymentCents} is null or ${table.yieldPaymentCents} > 0`),
  check("investment_payment_method_valid", sql`${table.paymentMethod} is null or ${table.paymentMethod} in ('PIX', 'TRANSFER', 'CASH', 'OTHER')`),
  // A conta vinculada é sempre do próprio investidor do contrato, na mesma carteira.
  foreignKey({ name: "investment_renewed_from_same_tenant_fk", columns: [table.tenantId, table.renewedFromInvestmentId], foreignColumns: [table.tenantId, table.id] }).onDelete("restrict"),
  uniqueIndex("investment_renewed_from_unique").on(table.renewedFromInvestmentId).where(sql`${table.renewedFromInvestmentId} is not null`),
  check("investment_renewed_from_not_self", sql`${table.renewedFromInvestmentId} is null or ${table.renewedFromInvestmentId} <> ${table.id}`),
  foreignKey({ name: "investment_bank_account_same_investor_fk", columns: [table.tenantId, table.investorId, table.bankAccountId], foreignColumns: [investorBankAccounts.tenantId, investorBankAccounts.investorId, investorBankAccounts.id] }).onDelete("restrict"),
  ...tenantPolicies("investment", table.tenantId),
]).enableRLS();

// Cronograma de pagamentos ao investidor: cada linha é uma data com os valores de rendimento e de devolução de principal
// DIGITADOS pelo usuário (o sistema não calcula rendimento). É só a agenda: não mexe no capital nem marca nada como pago.
// Os pagamentos (Etapa C, contas a pagar) vão se ligar a estas linhas por (tenant_id, id).
export const investmentScheduleItems = pgTable("investment_schedule_item", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  investmentId: text("investment_id").notNull(),
  number: integer("number").notNull(),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  yieldCents: bigint("yield_cents", { mode: "number" }).notNull().default(0),
  principalCents: bigint("principal_cents", { mode: "number" }).notNull().default(0),
  description: text("description"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("investment_schedule_item_tenant_due_idx").on(table.tenantId, table.dueDate),
  unique("investment_schedule_item_tenant_id_id_unique").on(table.tenantId, table.id),
  // Sem parcela repetida: gerar o cronograma duas vezes não duplica nada.
  uniqueIndex("investment_schedule_item_number_unique").on(table.investmentId, table.number),
  foreignKey({ name: "investment_schedule_item_investment_same_tenant_fk", columns: [table.tenantId, table.investmentId], foreignColumns: [investments.tenantId, investments.id] }).onDelete("restrict"),
  check("investment_schedule_item_number_positive", sql`${table.number} > 0`),
  check("investment_schedule_item_amounts_valid", sql`${table.yieldCents} >= 0 and ${table.principalCents} >= 0 and ${table.yieldCents} + ${table.principalCents} > 0`),
  ...tenantPolicies("investment_schedule_item", table.tenantId, { tenantDelete: true }),
]).enableRLS();

// Entrada do dinheiro de um contrato de investimento no capital da carteira (Contas a Pagar, migração 0022). Só existe
// quando o usuário confirma na página do contrato; nunca é automática. No máximo uma por contrato (índice único) e
// sempre ligada a UMA linha de capital_movement (CONTRIBUTION, categoria INVESTOR_CONTRIBUTION) do mesmo valor e data.
// Não se altera nem se apaga (gatilhos da migração 0022).
export const investmentCapitalEntries = pgTable("investment_capital_entry", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  investmentId: text("investment_id").notNull(),
  capitalMovementId: text("capital_movement_id").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  enteredOn: date("entered_on", { mode: "string" }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("investment_capital_entry_investment_unique").on(table.investmentId),
  uniqueIndex("investment_capital_entry_movement_unique").on(table.capitalMovementId),
  uniqueIndex("investment_capital_entry_tenant_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  foreignKey({ name: "investment_capital_entry_investment_same_tenant_fk", columns: [table.tenantId, table.investmentId], foreignColumns: [investments.tenantId, investments.id] }).onDelete("restrict"),
  foreignKey({ name: "investment_capital_entry_movement_same_tenant_fk", columns: [table.tenantId, table.capitalMovementId], foreignColumns: [capitalMovements.tenantId, capitalMovements.id] }).onDelete("restrict"),
  check("investment_capital_entry_amount_positive", sql`${table.amountCents} > 0`),
  pgPolicy("investment_capital_entry_select_tenant_or_admin", { for: "select", using: tenantScope(table.tenantId) }),
  pgPolicy("investment_capital_entry_insert_own_or_admin", { for: "insert", withCheck: tenantScope(table.tenantId) }),
  pgPolicy("investment_capital_entry_update_admin_only", { for: "update", using: adminScope, withCheck: adminScope }),
  pgPolicy("investment_capital_entry_delete_admin_only", { for: "delete", using: adminScope }),
]).enableRLS();

// Aporte anterior de um contrato antigo (migração 0023): só para contrato com capital_entry_rule NULL (já existia antes
// da regra da entrada), sem entrada registrada. O usuário indica o aporte comum (CONTRIBUTION da tela Capital, não
// estornado, do mesmo tenant) pelo qual o dinheiro do contrato já entrou no capital; com isso a baixa passa sem lançar
// uma nova entrada (que contaria o dinheiro em dobro). No máximo um por contrato; exclui a entrada (e vice-versa); não
// se altera nem se apaga; o aporte indicado não pode mais ser estornado (gatilhos da migração 0023).
export const investmentPriorContributions = pgTable("investment_prior_contribution", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  investmentId: text("investment_id").notNull(),
  capitalMovementId: text("capital_movement_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("investment_prior_contribution_investment_unique").on(table.investmentId),
  uniqueIndex("investment_prior_contribution_tenant_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  index("investment_prior_contribution_movement_idx").on(table.tenantId, table.capitalMovementId),
  foreignKey({ name: "investment_prior_contribution_investment_same_tenant_fk", columns: [table.tenantId, table.investmentId], foreignColumns: [investments.tenantId, investments.id] }).onDelete("restrict"),
  foreignKey({ name: "investment_prior_contribution_movement_same_tenant_fk", columns: [table.tenantId, table.capitalMovementId], foreignColumns: [capitalMovements.tenantId, capitalMovements.id] }).onDelete("restrict"),
  pgPolicy("investment_prior_contribution_select_tenant_or_admin", { for: "select", using: tenantScope(table.tenantId) }),
  pgPolicy("investment_prior_contribution_insert_own_or_admin", { for: "insert", withCheck: tenantScope(table.tenantId) }),
  pgPolicy("investment_prior_contribution_update_admin_only", { for: "update", using: adminScope, withCheck: adminScope }),
  pgPolicy("investment_prior_contribution_delete_admin_only", { for: "delete", using: adminScope }),
]).enableRLS();

// Baixa (pagamento efetivo) de uma obrigação do cronograma do investidor: rendimento (YIELD) ou devolução de principal
// (PRINCIPAL) de uma linha de investment_schedule_item. Pode haver várias baixas parciais por linha e tipo; a soma nunca
// passa do valor previsto (conferido na ação com a linha travada e de novo no gatilho da migração 0022). Cada baixa
// tem exatamente UMA saída em capital_movement (WITHDRAWAL, categoria de investidor) do mesmo valor e data. Não se
// altera nem se apaga: correção de baixa confirmada fica fora do escopo (documentado em etapa-C-contas-a-pagar.md).
export const investmentPayments = pgTable("investment_payment", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  investmentId: text("investment_id").notNull(),
  scheduleItemId: text("schedule_item_id").notNull(),
  kind: text("kind").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  paidOn: date("paid_on", { mode: "string" }).notNull(),
  method: text("method").notNull(),
  reference: text("reference"),
  notes: text("notes"),
  capitalMovementId: text("capital_movement_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("investment_payment_tenant_item_idx").on(table.tenantId, table.scheduleItemId),
  index("investment_payment_investment_idx").on(table.investmentId, table.paidOn),
  uniqueIndex("investment_payment_movement_unique").on(table.capitalMovementId),
  uniqueIndex("investment_payment_tenant_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  foreignKey({ name: "investment_payment_investment_same_tenant_fk", columns: [table.tenantId, table.investmentId], foreignColumns: [investments.tenantId, investments.id] }).onDelete("restrict"),
  foreignKey({ name: "investment_payment_schedule_item_same_tenant_fk", columns: [table.tenantId, table.scheduleItemId], foreignColumns: [investmentScheduleItems.tenantId, investmentScheduleItems.id] }).onDelete("restrict"),
  foreignKey({ name: "investment_payment_movement_same_tenant_fk", columns: [table.tenantId, table.capitalMovementId], foreignColumns: [capitalMovements.tenantId, capitalMovements.id] }).onDelete("restrict"),
  check("investment_payment_amount_positive", sql`${table.amountCents} > 0`),
  check("investment_payment_kind_valid", sql`${table.kind} in ('YIELD', 'PRINCIPAL')`),
  check("investment_payment_method_valid", sql`${table.method} in ('PIX', 'TRANSFER', 'CASH', 'OTHER')`),
  pgPolicy("investment_payment_select_tenant_or_admin", { for: "select", using: tenantScope(table.tenantId) }),
  pgPolicy("investment_payment_insert_own_or_admin", { for: "insert", withCheck: tenantScope(table.tenantId) }),
  pgPolicy("investment_payment_update_admin_only", { for: "update", using: adminScope, withCheck: adminScope }),
  pgPolicy("investment_payment_delete_admin_only", { for: "delete", using: adminScope }),
]).enableRLS();

// Histórico de alterações do contrato de investimento, visível para o próprio tenant (a auditoria completa continua em
// admin_audit_log, só para o MASTER). Cada linha guarda os campos alterados com o valor antes e depois. Não se edita nem
// se apaga pelo tenant.
export const investmentRevisions = pgTable("investment_revision", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  investmentId: text("investment_id").notNull(),
  // CONTRACT = dados do contrato; SCHEDULE = cronograma.
  kind: text("kind").notNull(),
  description: text("description").notNull(),
  changes: jsonb("changes").$type<{ field: string; before: string | null; after: string | null }[]>().notNull(),
  changedByUserId: text("changed_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("investment_revision_investment_idx").on(table.investmentId, table.createdAt),
  foreignKey({ name: "investment_revision_investment_same_tenant_fk", columns: [table.tenantId, table.investmentId], foreignColumns: [investments.tenantId, investments.id] }).onDelete("restrict"),
  check("investment_revision_kind_valid", sql`${table.kind} in ('CONTRACT', 'SCHEDULE')`),
  pgPolicy("investment_revision_select_tenant_or_admin", { for: "select", using: tenantScope(table.tenantId) }),
  pgPolicy("investment_revision_insert_own_or_admin", { for: "insert", withCheck: tenantScope(table.tenantId) }),
  pgPolicy("investment_revision_update_admin_only", { for: "update", using: adminScope, withCheck: adminScope }),
  pgPolicy("investment_revision_delete_admin_only", { for: "delete", using: adminScope }),
]).enableRLS();

// Empresa contratante dos contratos de investimento (uma por tenant). Os dados são digitados e confirmados pelo próprio
// tenant (ou pelo MASTER): o contrato só é gerado com eles completos e confirmed_at preenchido. Nada vem do nome do tenant.
export const investmentContractors = pgTable("investment_contractor", {
  tenantId: text("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  // Razão social (ou nome, se a contratante for pessoa física) e CNPJ/CPF, só dígitos.
  legalName: text("legal_name"),
  document: text("document"),
  addressCep: text("address_cep"),
  addressStreet: text("address_street"),
  addressNumber: text("address_number"),
  addressComplement: text("address_complement"),
  addressDistrict: text("address_district"),
  addressCity: text("address_city"),
  addressState: text("address_state"),
  // Representante legal que assina pela empresa (opcional).
  representativeName: text("representative_name"),
  representativeDocument: text("representative_document"),
  // Preenchido quando o usuário confirma os dados; qualquer gravação sem a confirmação volta a null.
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  confirmedByUserId: text("confirmed_by_user_id"),
  updatedByUserId: text("updated_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  ...tenantPolicies("investment_contractor", table.tenantId),
]).enableRLS();

// Contratos GERADOS pelo sistema (PDF ainda não assinado), em versões numeradas por investimento. Não se confundem com o
// contrato assinado, que continua em investment_document (kind SIGNED_CONTRACT) e aponta para a versão que foi assinada.
// Gerar nova versão só marca a anterior como substituída: nenhuma versão e nenhum documento assinado é apagado.
export const investmentContracts = pgTable("investment_contract", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  investmentId: text("investment_id").notNull(),
  version: integer("version").notNull(),
  // Modelo usado e o hash dos dados que entraram no contrato (para saber se os dados mudaram desde esta versão).
  templateVersion: text("template_version").notNull(),
  dataHash: text("data_hash").notNull(),
  includesNotes: boolean("includes_notes").notNull(),
  fileName: text("file_name").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  content: bytea("content").notNull(),
  generatedByUserId: text("generated_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Marcado à mão quando o usuário envia o PDF para o investidor assinar (o envio é feito fora do sistema).
  sentAt: timestamp("sent_at", { withTimezone: true }),
  sentByUserId: text("sent_by_user_id"),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  supersededByContractId: text("superseded_by_contract_id"),
}, (table) => [
  index("investment_contract_investment_id_idx").on(table.investmentId),
  unique("investment_contract_tenant_id_id_unique").on(table.tenantId, table.id),
  uniqueIndex("investment_contract_version_unique").on(table.investmentId, table.version),
  // Uma única versão vigente por investimento.
  uniqueIndex("investment_contract_current_unique").on(table.investmentId).where(sql`${table.supersededAt} is null`),
  foreignKey({ name: "investment_contract_investment_same_tenant_fk", columns: [table.tenantId, table.investmentId], foreignColumns: [investments.tenantId, investments.id] }).onDelete("restrict"),
  check("investment_contract_version_positive", sql`${table.version} > 0`),
  check("investment_contract_size_limit", sql`${table.sizeBytes} > 0 and ${table.sizeBytes} <= 5242880`),
  check("investment_contract_superseded_link", sql`(${table.supersededAt} is null) = (${table.supersededByContractId} is null)`),
  check("investment_contract_sent_link", sql`(${table.sentAt} is null) = (${table.sentByUserId} is null)`),
  ...tenantPolicies("investment_contract", table.tenantId),
]).enableRLS();

// Documentos do INVESTIMENTO (não do investidor): contrato assinado, aditivos, comprovantes. O arquivo fica no banco,
// como os documentos de clientes. Substituir não apaga: a versão anterior fica no histórico com replaced_at.
export const investmentDocuments = pgTable("investment_document", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  investmentId: text("investment_id").notNull(),
  kind: investmentDocumentKind("kind").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  content: bytea("content").notNull(),
  uploadedByUserId: text("uploaded_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  replacedAt: timestamp("replaced_at", { withTimezone: true }),
  replacedByDocumentId: text("replaced_by_document_id"),
  // Contrato assinado: a versão gerada pelo sistema que foi assinada (null = contrato não gerado pelo sistema).
  contractId: text("contract_id"),
}, (table) => [
  index("investment_document_investment_id_idx").on(table.investmentId),
  foreignKey({ name: "investment_document_investment_same_tenant_fk", columns: [table.tenantId, table.investmentId], foreignColumns: [investments.tenantId, investments.id] }).onDelete("restrict"),
  foreignKey({ name: "investment_document_contract_same_tenant_fk", columns: [table.tenantId, table.contractId], foreignColumns: [investmentContracts.tenantId, investmentContracts.id] }).onDelete("restrict"),
  check("investment_document_contract_only_signed", sql`${table.contractId} is null or ${table.kind} = 'SIGNED_CONTRACT'`),
  // Um único contrato assinado vigente por investimento; os anteriores ficam como substituídos.
  uniqueIndex("investment_document_current_contract_unique").on(table.investmentId).where(sql`${table.kind} = 'SIGNED_CONTRACT' and ${table.replacedAt} is null`),
  check("investment_document_size_limit", sql`${table.sizeBytes} > 0 and ${table.sizeBytes} <= 5242880`),
  check("investment_document_replaced_link", sql`(${table.replacedAt} is null) = (${table.replacedByDocumentId} is null)`),
  ...tenantPolicies("investment_document", table.tenantId),
]).enableRLS();

// Auditoria administrativa: quem fez o quê na administração da plataforma (somente SUPER_ADMIN lê; grava o SUPER_ADMIN e,
// no módulo Investidores, também o usuário do próprio tenant).
// Sem chaves estrangeiras de propósito: o registro sobrevive mesmo que o tenant ou o usuário deixem de existir, e por
// isso guarda também o nome e o e-mail de quem agiu e o nome do tenant no momento da ação. É só de inserção: não há
// política de UPDATE/DELETE e o gatilho admin_audit_log_append_only (migração 0014) recusa alteração e exclusão até
// para o dono do banco. Senhas e hashes nunca entram em before/after.
export const adminAuditLogs = pgTable("admin_audit_log", {
  id: text("id").primaryKey(),
  // clock_timestamp(): vários eventos da mesma ação (mesma transação) ficam na ordem em que foram gravados.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  actorUserId: text("actor_user_id").notNull(),
  actorName: text("actor_name").notNull(),
  actorEmail: text("actor_email").notNull(),
  tenantId: text("tenant_id"),
  tenantName: text("tenant_name"),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  description: text("description").notNull(),
  before: jsonb("before").$type<Record<string, unknown>>(),
  after: jsonb("after").$type<Record<string, unknown>>(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
}, (table) => [
  index("admin_audit_log_created_at_idx").on(table.createdAt),
  index("admin_audit_log_tenant_idx").on(table.tenantId, table.createdAt),
  index("admin_audit_log_action_idx").on(table.action, table.createdAt),
  pgPolicy("admin_audit_log_select_admin_only", { for: "select", using: adminScope }),
  pgPolicy("admin_audit_log_insert_admin_only", { for: "insert", withCheck: adminScope }),
  // O usuário do tenant também registra o que faz no módulo Investidores, só no próprio tenant (e continua sem ler o log).
  pgPolicy("admin_audit_log_insert_tenant_investors", { for: "insert", withCheck: sql`${roleSetting} = 'TENANT_USER' and ${table.tenantId} = ${tenantSetting} and ${table.entity} in ('investor', 'investment', 'investment_document', 'investment_contract', 'investment_contractor')` }),
  // E os lançamentos do módulo Financeiro (entradas e saídas manuais) e a mudança do capital inicial, também só no próprio tenant.
  pgPolicy("admin_audit_log_insert_tenant_finance", { for: "insert", withCheck: sql`${roleSetting} = 'TENANT_USER' and ${table.tenantId} = ${tenantSetting} and ${table.entity} in ('capital_movement', 'wallet')` }),
  // Contas a Pagar: baixas de obrigações de investidores do próprio tenant (migração 0022).
  pgPolicy("admin_audit_log_insert_tenant_payables", { for: "insert", withCheck: sql`${roleSetting} = 'TENANT_USER' and ${table.tenantId} = ${tenantSetting} and ${table.entity} = 'investment_payment'` }),
  // E as correções de operação (Etapa G), também só no próprio tenant.
  pgPolicy("admin_audit_log_insert_tenant_operations", { for: "insert", withCheck: sql`${roleSetting} = 'TENANT_USER' and ${table.tenantId} = ${tenantSetting} and ${table.entity} = 'loan_operation'` }),
  // Contas bancárias e documentos do investidor (migração 0024), também só no próprio tenant.
  pgPolicy("admin_audit_log_insert_tenant_investor_records", { for: "insert", withCheck: sql`${roleSetting} = 'TENANT_USER' and ${table.tenantId} = ${tenantSetting} and ${table.entity} in ('investor_bank_account', 'investor_document')` }),
]).enableRLS();

export const schema = { accounts, adminAuditLogs, capitalMovements, clientDocuments, clients, investmentContractors, investmentContracts, investmentDocuments, investmentRevisions, investmentScheduleItems, investments, installmentDeferrals, investors, loanOperationRevisions, loanOperations, loanRenewals, paymentRevisions, payments, plans, sessions, subscriptionCharges, subscriptions, tenants, users, verifications, walletCycles, wallets };
