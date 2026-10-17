"use server";

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordAdminAudit, type AuditActor } from "@/lib/admin/audit";
import type { AuditAction } from "@/lib/admin/audit-rules";
import type { TenantTransaction } from "@/lib/auth/guards";
import { investmentCapitalEntries, investmentContractors, investmentContracts, investmentDocuments, investmentPayments, investmentPriorContributions, investmentRevisions, investmentScheduleItems, investments, investorBankAccounts, investorDocuments, investors, tenants } from "@/lib/db/schema";
import { formatDate, formatMoney, todayIso } from "@/lib/finance/format";
import { accountFitsMethod, bankAccountFields, bankAccountLabel, type BankAccountValues } from "@/lib/investors/bank-accounts";
import { tenantFilter, withInvestorContext } from "@/lib/investors/access";
import { CONTRACT_TEMPLATE_VERSION, buildContract, contractFileName, contractorFields, missingContractData } from "@/lib/investors/contract";
import { contractFonts } from "@/lib/investors/contract-fonts";
import { renderContractPdf } from "@/lib/investors/contract-pdf";
import { contractDataHash, contractSource, loadContractor } from "@/lib/investors/contract-source";
import {
  DOCUMENT_KINDS, INVESTOR_DOCUMENT_KINDS, MAX_SCHEDULE_ITEMS, investmentChanges, investmentFields, investorAddressKeys, investorFields, parseDocumentKind, parseInvestorDocumentKind,
  scheduleDateProblem, scheduleItemFields, scheduleLinesFields, scheduleSummary, scheduleVersion,
  type InvestmentValues, type InvestorValues, type PersonType, type ScheduleItemValues, type TermUnit, type InvestmentPaymentMethod,
} from "@/lib/investors/rules";

export type InvestorActionResult = { ok: true; message: string; id?: string } | { ok: false; error: string };

// Toda autorização é feita aqui, no servidor: o tenant vem da sessão (ou, para o MASTER, do registro que ele administra).
// O navegador nunca escolhe o tenant de um usuário comum. Cada alteração grava auditoria na mesma transação.

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const reader = (data: FormData) => (key: string, max: number) => String(data.get(key) ?? "").trim().slice(0, max);

// Observações não vão em texto para a auditoria (podem ter dados sensíveis): só se estão preenchidas e o tamanho.
const notesMark = (notes: string | null) => (notes ? `preenchidas (${notes.length} caracteres)` : null);
// Endereço também não vai por extenso: só se está preenchido e a cidade/UF.
const addressMark = (values: { addressStreet: string | null; addressCity: string | null; addressState: string | null; addressCep: string | null }) =>
  values.addressStreet || values.addressCity || values.addressCep ? `preenchido (${[values.addressCity, values.addressState].filter(Boolean).join("/") || "sem cidade"})` : null;
// Dados bancários nunca vão para a auditoria (ficam em investor_bank_account; a auditoria da conta só diz o que mudou).
// O CPF/CNPJ vai como está (já ia antes); a data de nascimento/abertura só como "preenchida".
function investorSnapshot(values: InvestorValues) {
  const snapshot: Record<string, unknown> = { ...values, notes: notesMark(values.notes), address: addressMark(values), birthDate: values.birthDate ? "preenchida" : null };
  for (const key of investorAddressKeys) delete snapshot[key];
  return snapshot;
}
const investmentSnapshot = (values: InvestmentValues) => ({ ...values, notes: notesMark(values.notes), yieldTerms: notesMark(values.yieldTerms), principalTerms: notesMark(values.principalTerms) });

async function tenantName(tx: TenantTransaction, tenantId: string) {
  const [row] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  return row?.name ?? null;
}

async function audit(tx: TenantTransaction, actor: AuditActor, tenantId: string, action: AuditAction, entity: string, entityId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, description?: string) {
  await recordAdminAudit(tx, actor, { action, entity, entityId, tenantId, tenantName: await tenantName(tx, tenantId), before, after, description });
}

const violates = (constraint: RegExp) => (error: unknown) => error instanceof Error && constraint.test(`${error.message} ${(error as { cause?: Error }).cause?.message ?? ""}`);
const duplicateDocument = violates(/investor_tenant_document_unique/);
// Dois envios simultâneos de contrato assinado: o índice único garante um só vigente; o segundo recebe esta mensagem.
const duplicateSignedContract = violates(/investment_document_current_contract_unique/);
const SIGNED_CONTRACT_ERROR = { ok: false as const, error: "Este investimento já tem contrato assinado. Use \"Substituir\" para enviar uma nova versão." };
const DUPLICATE_ERROR = { ok: false as const, error: "Já existe um investidor com este CPF/CNPJ nesta carteira." };
const duplicateContractNumber = violates(/investment_tenant_contract_number_unique/);
const CONTRACT_NUMBER_ERROR = { ok: false as const, error: "Já existe um contrato com esta identificação nesta carteira." };

function refresh() {
  revalidatePath("/investidores", "layout");
  revalidatePath("/contas-a-pagar");
}

// Dinheiro já movimentado pelo contrato (Contas a Pagar): a entrada registrada no capital (ou o aporte anterior indicado,
// migração 0023) e as linhas do cronograma com baixa. Com eles, o que deu origem aos lançamentos não muda mais, para preservar o histórico financeiro.
async function cashOf(tx: TenantTransaction, investment: { id: string; tenantId: string }) {
  const [entry] = await tx.select({ amountCents: investmentCapitalEntries.amountCents, enteredOn: investmentCapitalEntries.enteredOn }).from(investmentCapitalEntries)
    .where(and(eq(investmentCapitalEntries.investmentId, investment.id), eq(investmentCapitalEntries.tenantId, investment.tenantId)));
  const paid = await tx.selectDistinct({ itemId: investmentPayments.scheduleItemId }).from(investmentPayments)
    .where(and(eq(investmentPayments.investmentId, investment.id), eq(investmentPayments.tenantId, investment.tenantId)));
  const [prior] = await tx.select({ id: investmentPriorContributions.id }).from(investmentPriorContributions)
    .where(and(eq(investmentPriorContributions.investmentId, investment.id), eq(investmentPriorContributions.tenantId, investment.tenantId)));
  return { entry: entry ?? null, prior: Boolean(prior), paidItemIds: new Set(paid.map((row) => row.itemId)) };
}
const PAID_ITEM_ERROR = { ok: false as const, error: "Esta linha do cronograma já tem pagamento registrado em Contas a Pagar. Para preservar o histórico financeiro, ela não pode ser alterada nem retirada." };

export async function createInvestorAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const fields = investorFields(read, todayIso());
  if (!fields.ok) return fields;
  try {
    const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
      // Usuário do tenant: sempre a própria carteira. MASTER: a carteira escolhida (precisa existir e não estar encerrada).
      let tenantId = scope.tenantId;
      if (scope.isMaster) {
        const chosen = read("tenantId", 80) || scope.tenantId || "";
        const [tenant] = await tx.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.id, chosen), ne(tenants.status, "CLOSED")));
        tenantId = tenant?.id ?? null;
      }
      if (!tenantId) return { ok: false, error: "Escolha a carteira do investidor." };
      const investorId = id("inv");
      await tx.insert(investors).values({ id: investorId, tenantId, ...fields.values, createdByUserId: scope.user.id });
      await audit(tx, scope, tenantId, "INVESTOR_CREATED", "investor", investorId, null, investorSnapshot(fields.values), `Investidor ${fields.values.name} cadastrado`);
      return { ok: true, message: `Investidor ${fields.values.name} cadastrado.`, id: investorId };
    });
    if (result.ok) refresh();
    return result;
  } catch (error) {
    if (duplicateDocument(error)) return DUPLICATE_ERROR;
    throw error;
  }
}

export async function updateInvestorAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investorId = read("investorId", 80);
  if (!investorId) return { ok: false, error: "Investidor inválido." };
  const fields = investorFields(read, todayIso());
  if (!fields.ok) return fields;
  try {
    const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
      const [current] = await tx.select().from(investors).where(and(eq(investors.id, investorId), tenantFilter(scope, investors.tenantId)));
      if (!current) return { ok: false, error: "Investidor não encontrado." };
      await tx.update(investors).set({ ...fields.values, updatedAt: sql`now()` }).where(and(eq(investors.id, current.id), eq(investors.tenantId, current.tenantId)));
      // As colunas bancárias antigas do investidor não são tocadas aqui (nem lidas para a auditoria).
      const before = investorSnapshot({
        personType: current.personType as PersonType, name: current.name, tradeName: current.tradeName, document: current.document as string, birthDate: current.birthDate,
        phone: current.phone, whatsapp: current.whatsapp, email: current.email, instagram: current.instagram, facebook: current.facebook, notes: current.notes, status: current.status,
        ...(Object.fromEntries(investorAddressKeys.map((key) => [key, current[key]])) as Pick<InvestorValues, (typeof investorAddressKeys)[number]>),
      });
      const after = investorSnapshot(fields.values);
      const { status: statusBefore, ...dataBefore } = before;
      const { status: statusAfter, ...dataAfter } = after;
      if (JSON.stringify(dataBefore) !== JSON.stringify(dataAfter)) await audit(tx, scope, current.tenantId, "INVESTOR_UPDATED", "investor", current.id, dataBefore, dataAfter, `Dados do investidor ${fields.values.name} alterados`);
      if (statusBefore !== statusAfter) await audit(tx, scope, current.tenantId, "INVESTOR_STATUS_CHANGED", "investor", current.id, { status: statusBefore }, { status: statusAfter }, `Status do investidor ${fields.values.name} alterado`);
      return { ok: true, message: `Investidor ${fields.values.name} atualizado.`, id: current.id };
    });
    if (result.ok) refresh();
    return result;
  } catch (error) {
    if (duplicateDocument(error)) return DUPLICATE_ERROR;
    throw error;
  }
}

// Conta bancária escolhida no contrato: do próprio investidor e da mesma carteira, não retirada, e compatível com a forma
// de pagamento (Pix pede chave Pix; transferência pede banco, agência e conta). O banco confere o investidor e a carteira
// de novo pela chave estrangeira composta. Devolve o texto mascarado da conta para o histórico.
async function checkBankAccount(tx: TenantTransaction, investor: { id: string; tenantId: string }, values: InvestmentValues, keepArchivedId?: string | null) {
  if (!values.bankAccountId) return { ok: true as const, labels: new Map<string, string>() };
  const [account] = await tx.select().from(investorBankAccounts)
    .where(and(eq(investorBankAccounts.id, values.bankAccountId), eq(investorBankAccounts.investorId, investor.id), eq(investorBankAccounts.tenantId, investor.tenantId)));
  if (!account) return { ok: false as const, error: "Escolha uma conta bancária deste investidor." };
  // Uma conta retirada só continua valendo no contrato que já a usava (nada é trocado sozinho).
  if (account.archivedAt && account.id !== keepArchivedId) return { ok: false as const, error: "Esta conta bancária foi retirada. Escolha outra conta do investidor." };
  const problem = accountFitsMethod(values.paymentMethod, account);
  if (problem) return { ok: false as const, error: problem };
  return { ok: true as const, labels: new Map([[account.id, bankAccountLabel(account)]]) };
}

async function accountLabels(tx: TenantTransaction, tenantId: string, ids: (string | null)[]) {
  const wanted = ids.filter((value): value is string => Boolean(value));
  if (wanted.length === 0) return new Map<string, string>();
  const rows = await tx.select().from(investorBankAccounts).where(and(eq(investorBankAccounts.tenantId, tenantId), inArray(investorBankAccounts.id, wanted)));
  return new Map(rows.map((row) => [row.id, bankAccountLabel(row)]));
}

export async function createInvestmentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investorId = read("investorId", 80);
  if (!investorId) return { ok: false, error: "Investidor inválido." };
  const fields = investmentFields(read);
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const [investor] = await tx.select().from(investors).where(and(eq(investors.id, investorId), tenantFilter(scope, investors.tenantId)));
    if (!investor) return { ok: false, error: "Investidor não encontrado." };
    if (investor.status !== "ACTIVE") return { ok: false, error: "Reative o investidor antes de cadastrar um novo investimento." };
    const account = await checkBankAccount(tx, investor, fields.values);
    if (!account.ok) return account;
    const investmentId = id("ivt");
    // O contrato fica sempre na carteira do investidor.
    await tx.insert(investments).values({ id: investmentId, tenantId: investor.tenantId, investorId: investor.id, ...fields.values, createdByUserId: scope.user.id });
    await audit(tx, scope, investor.tenantId, "INVESTMENT_CREATED", "investment", investmentId, null, { investorId: investor.id, investorName: investor.name, ...investmentSnapshot(fields.values) },
      `Investimento de ${formatMoney(fields.values.amountCents)} cadastrado para ${investor.name}`);
    return { ok: true, message: `Investimento de ${formatMoney(fields.values.amountCents)} cadastrado para ${investor.name}.`, id: investmentId };
  }).catch((error) => {
    if (duplicateContractNumber(error)) return CONTRACT_NUMBER_ERROR;
    throw error;
  });
  if (result.ok) refresh();
  return result;
}

export async function updateInvestmentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  const fields = investmentFields(read);
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const [current] = await tx.select({ investment: investments, investorName: investors.name }).from(investments)
      .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
      // FOR NO KEY UPDATE: segura o contrato contra outra edição sem bloquear a chave estrangeira de uma baixa em andamento.
      .where(and(eq(investments.id, investmentId), tenantFilter(scope, investments.tenantId))).for("no key update", { of: investments });
    if (!current) return { ok: false, error: "Investimento não encontrado." };
    const { investment } = current;
    const account = await checkBankAccount(tx, { id: investment.investorId, tenantId: investment.tenantId }, fields.values, investment.bankAccountId);
    if (!account.ok) return account;
    // O valor do contrato não pode ficar abaixo do principal já agendado no cronograma nem do principal já devolvido.
    const [{ scheduled }] = await tx.select({ scheduled: sql<string>`coalesce(sum(${investmentScheduleItems.principalCents}), 0)` }).from(investmentScheduleItems)
      .where(and(eq(investmentScheduleItems.investmentId, investment.id), eq(investmentScheduleItems.tenantId, investment.tenantId)));
    if (fields.values.amountCents < Number(scheduled)) {
      return { ok: false, error: `O cronograma já agenda ${formatMoney(Number(scheduled))} de devolução do principal, mais que o novo valor de ${formatMoney(fields.values.amountCents)}. Ajuste o cronograma antes.` };
    }
    const [child] = await tx.select({ id: investments.id }).from(investments).where(and(eq(investments.renewedFromInvestmentId, investment.id), eq(investments.tenantId, investment.tenantId)));
    if ((investment.renewedFromInvestmentId || child) && fields.values.amountCents !== investment.amountCents) {
      return { ok: false, error: investment.renewedFromInvestmentId ? "Contrato de renovação: o valor é o principal que veio do contrato anterior e não muda." : "Este contrato já foi renovado: o valor não muda mais." };
    }
    if ((investment.renewedFromInvestmentId || child) && fields.values.status === "CANCELED" && investment.status !== "CANCELED") {
      return { ok: false, error: "Contrato de uma renovação não pode ser cancelado." };
    }
    const cash = await cashOf(tx, investment);
    if (cash.entry && (fields.values.amountCents !== investment.amountCents || (fields.values.investedOn ?? fields.values.startDate) !== (investment.investedOn ?? investment.startDate))) {
      return { ok: false, error: `A entrada deste investimento já foi registrada no capital (${formatMoney(cash.entry.amountCents)} em ${formatDate(cash.entry.enteredOn)}). Para preservar o histórico financeiro, o valor e a data do investimento não podem mais ser alterados.` };
    }
    if (cash.paidItemIds.size > 0 && fields.values.startDate !== investment.startDate) {
      return { ok: false, error: "Este contrato já tem pagamentos registrados em Contas a Pagar. Para preservar o histórico financeiro, a data de início não pode mais ser alterada." };
    }
    if ((cash.entry || cash.prior || cash.paidItemIds.size > 0) && fields.values.status === "CANCELED" && investment.status !== "CANCELED") {
      return { ok: false, error: "Este contrato já está ligado ao capital (entrada, aporte anterior indicado ou pagamentos registrados) e não pode ser cancelado. A regra para desfazer esses lançamentos ainda não foi definida." };
    }
    const beforeValues: InvestmentValues = {
      amountCents: investment.amountCents, agreedRateBps: investment.agreedRateBps, ratePeriod: investment.ratePeriod, startDate: investment.startDate,
      maturityDate: investment.maturityDate, dueDay: investment.dueDay, notes: investment.notes, status: investment.status,
      contractNumber: investment.contractNumber, investedOn: investment.investedOn, termMonths: investment.termMonths,
      paymentFrequency: investment.paymentFrequency as InvestmentValues["paymentFrequency"], installmentCount: investment.installmentCount,
      contractedOn: investment.contractedOn, termCount: investment.termCount, termUnit: investment.termUnit as TermUnit | null, paymentMethod: investment.paymentMethod as InvestmentPaymentMethod | null,
      bankAccountId: investment.bankAccountId, yieldTerms: investment.yieldTerms, principalTerms: investment.principalTerms,
      redemptionRule: investment.redemptionRule as InvestmentValues["redemptionRule"], redemptionDays: investment.redemptionDays, yieldPaymentCents: investment.yieldPaymentCents,
    };
    // O prazo no formato anterior (term_months) vem preenchido no formulário em meses e é gravado no formato novo
    // (term_count/term_unit); o texto ("12 meses") é o mesmo, então não conta como alteração.
    const afterValues = fields.values;
    const { status: statusBefore, ...dataBefore } = investmentSnapshot(beforeValues);
    const { status: statusAfter, ...dataAfter } = investmentSnapshot(afterValues);
    // Histórico visível para o tenant: o que mudou, antes e depois (a conta bancária aparece mascarada).
    const labels = await accountLabels(tx, investment.tenantId, [beforeValues.bankAccountId, afterValues.bankAccountId]);
    const changes = investmentChanges(beforeValues, afterValues, (accountId) => labels.get(accountId) ?? "conta do investidor");
    await tx.update(investments).set({ ...afterValues, updatedAt: sql`now()` }).where(and(eq(investments.id, investment.id), eq(investments.tenantId, investment.tenantId)));
    if (changes.length > 0) {
      await tx.insert(investmentRevisions).values({ id: id("ivr"), tenantId: investment.tenantId, investmentId: investment.id, kind: "CONTRACT", description: "Dados do contrato alterados", changes, changedByUserId: scope.user.id });
    }
    if (JSON.stringify(dataBefore) !== JSON.stringify(dataAfter)) await audit(tx, scope, investment.tenantId, "INVESTMENT_UPDATED", "investment", investment.id, dataBefore, dataAfter, `Investimento de ${current.investorName} alterado`);
    if (statusBefore !== statusAfter) await audit(tx, scope, investment.tenantId, "INVESTMENT_STATUS_CHANGED", "investment", investment.id, { status: statusBefore }, { status: statusAfter }, `Status do investimento de ${current.investorName} alterado`);
    return { ok: true, message: "Investimento atualizado.", id: investment.id };
  }).catch((error) => {
    if (duplicateContractNumber(error)) return CONTRACT_NUMBER_ERROR;
    throw error;
  });
  if (result.ok) refresh();
  return result;
}

// ── Cronograma de pagamentos ao investidor ──────────────────────────────────────────────────────────────────────────
// Valores e datas digitados pelo usuário; nada aqui calcula rendimento nem mexe no capital. Cada alteração trava o
// investimento (FOR UPDATE), grava o histórico visível e a auditoria na mesma transação.

type ScheduleContext = { investment: typeof investments.$inferSelect; investorName: string; items: (typeof investmentScheduleItems.$inferSelect)[] };

async function lockSchedule(tx: TenantTransaction, scope: Parameters<Parameters<typeof withInvestorContext>[0]>[1], investmentId: string): Promise<ScheduleContext | { ok: false; error: string }> {
  const [row] = await tx.select({ investment: investments, investorName: investors.name }).from(investments)
    .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
    // Ordem das travas: o contrato (FOR NO KEY UPDATE, que não bloqueia a chave estrangeira de uma baixa) e depois as
    // linhas (FOR UPDATE). Uma baixa da mesma linha em andamento termina antes; aí a linha já aparece como paga e fica travada.
    .where(and(eq(investments.id, investmentId), tenantFilter(scope, investments.tenantId))).for("no key update", { of: investments });
  if (!row) return { ok: false, error: "Investimento não encontrado." };
  if (row.investment.status === "CANCELED" || row.investment.status === "CLOSED") return { ok: false, error: "Este investimento está encerrado ou cancelado: o cronograma não pode mais ser alterado." };
  const items = await tx.select().from(investmentScheduleItems)
    .where(and(eq(investmentScheduleItems.investmentId, row.investment.id), eq(investmentScheduleItems.tenantId, row.investment.tenantId)))
    .orderBy(asc(investmentScheduleItems.dueDate), asc(investmentScheduleItems.number)).for("update");
  return { ...row, items };
}

// Grava a linha do histórico e devolve o resumo antes/depois para a auditoria (que cada ação grava em seguida).
async function recordScheduleRevision(tx: TenantTransaction, userId: string, context: ScheduleContext, after: ScheduleItemValues[], description: string) {
  const before = scheduleSummary(context.items);
  const now = scheduleSummary(after);
  const { investment } = context;
  await tx.insert(investmentRevisions).values({ id: id("ivr"), tenantId: investment.tenantId, investmentId: investment.id, kind: "SCHEDULE", description, changes: [{ field: "Cronograma", before, after: now }], changedByUserId: userId });
  return [investment.tenantId, "INVESTMENT_SCHEDULE_UPDATED", "investment", investment.id, { schedule: before }, { schedule: now }, `${description} (investimento de ${context.investorName})`] as const;
}

// A devolução do principal somada em todas as linhas não pode passar do valor investido no contrato (só o rendimento é
// livre). Sem isso, um contrato de R$ 20.000 com duas linhas de R$ 20.000 de principal gerava R$ 40.000 a pagar.
function principalOverflow(investment: typeof investments.$inferSelect, items: { principalCents: number }[]): { ok: false; error: string } | null {
  const principalCents = items.reduce((total, item) => total + item.principalCents, 0);
  if (principalCents <= investment.amountCents) return null;
  return { ok: false, error: `A devolução do principal no cronograma somaria ${formatMoney(principalCents)}, mais que o valor investido de ${formatMoney(investment.amountCents)}. Confira os valores de principal.` };
}

const itemValues = (items: (typeof investmentScheduleItems.$inferSelect)[]) => items.map(({ dueDate, yieldCents, principalCents, description }) => ({ dueDate, yieldCents, principalCents, description }));

// Datas das linhas comparadas com o contrato (nenhuma antes do início).
function datesProblem(investment: typeof investments.$inferSelect, items: { dueDate: string }[]) {
  for (const item of items) {
    const problem = scheduleDateProblem(item.dueDate, investment);
    if (problem) return { ok: false as const, error: `${problem} Nada foi gravado.` };
  }
  return null;
}

// Grava um lote de linhas revisado na tela (a sugestão pela periodicidade é montada e revisada no navegador; nada é
// gerado aqui). "append" acrescenta ao cronograma; "replace" substitui o cronograma inteiro, só com a confirmação e só
// se nenhuma linha tiver baixa. O mesmo lote enviado duas vezes com "replace" não duplica nada.
export async function saveInvestmentScheduleLinesAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  const mode = read("mode", 10);
  if (mode !== "append" && mode !== "replace") return { ok: false, error: "Escolha se as linhas serão acrescentadas ou se substituem o cronograma." };
  const lines = scheduleLinesFields(String(data.get("lines") ?? "").slice(0, 200_000));
  if (!lines.ok) return lines;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const context = await lockSchedule(tx, scope, investmentId);
    if ("ok" in context) return context;
    const { investment } = context;
    // A revisão foi montada vendo N linhas gravadas; se o cronograma mudou desde então (outro envio, outra aba), nada é
    // gravado. Isso também impede que um clique repetido inclua as mesmas linhas duas vezes.
    const seen = read("seen", 40);
    if (seen !== "" && seen !== scheduleVersion(context.items)) return { ok: false, error: "O cronograma mudou desde que você abriu esta revisão (por exemplo, as linhas já foram gravadas). Nada foi gravado: atualize a página e confira." };
    const dates = datesProblem(investment, lines.items);
    if (dates) return dates;
    const replacing = mode === "replace";
    if (replacing) {
      if ((await cashOf(tx, investment)).paidItemIds.size > 0) return { ok: false, error: "Este cronograma já tem pagamentos registrados em Contas a Pagar e não pode ser substituído. Acrescente novas linhas ou edite as que ainda não foram pagas." };
      if (context.items.length > 0 && read("replace", 4) !== "1") return { ok: false, error: `Este investimento já tem um cronograma com ${context.items.length} ${context.items.length === 1 ? "pagamento" : "pagamentos"}. Confirme que deseja substituí-lo.` };
    }
    const kept = replacing ? [] : context.items;
    if (kept.length + lines.items.length > MAX_SCHEDULE_ITEMS) return { ok: false, error: `O cronograma pode ter no máximo ${MAX_SCHEDULE_ITEMS} pagamentos.` };
    const overflow = principalOverflow(investment, [...kept, ...lines.items]);
    if (overflow) return overflow;
    if (replacing) await tx.delete(investmentScheduleItems).where(and(eq(investmentScheduleItems.investmentId, investment.id), eq(investmentScheduleItems.tenantId, investment.tenantId)));
    const first = replacing ? 1 : Math.max(0, ...context.items.map((item) => item.number)) + 1;
    await tx.insert(investmentScheduleItems).values(lines.items.map((item, index) => ({
      id: id("ivs"), tenantId: investment.tenantId, investmentId: investment.id, number: first + index, ...item, createdByUserId: scope.user.id,
    })));
    const description = replacing ? (context.items.length > 0 ? "Cronograma substituído" : "Cronograma montado") : `${lines.items.length} ${lines.items.length === 1 ? "pagamento incluído" : "pagamentos incluídos"} no cronograma`;
    await audit(tx, scope, ...(await recordScheduleRevision(tx, scope.user.id, context, [...itemValues(kept), ...lines.items], description)));
    return { ok: true, message: `${lines.items.length} ${lines.items.length === 1 ? "pagamento gravado" : "pagamentos gravados"} no cronograma.`, id: investment.id };
  });
  if (result.ok) refresh();
  return result;
}

// Inclui uma linha (datas irregulares ou um pagamento extra combinado).
export async function addInvestmentScheduleItemAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  const fields = scheduleItemFields(read);
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const context = await lockSchedule(tx, scope, investmentId);
    if ("ok" in context) return context;
    if (context.items.length >= MAX_SCHEDULE_ITEMS) return { ok: false, error: `O cronograma pode ter no máximo ${MAX_SCHEDULE_ITEMS} pagamentos.` };
    const { investment } = context;
    const dates = datesProblem(investment, [fields.values]);
    if (dates) return dates;
    const overflow = principalOverflow(investment, [...context.items, fields.values]);
    if (overflow) return overflow;
    const [last] = await tx.select({ number: max(investmentScheduleItems.number) }).from(investmentScheduleItems)
      .where(and(eq(investmentScheduleItems.investmentId, investment.id), eq(investmentScheduleItems.tenantId, investment.tenantId)));
    await tx.insert(investmentScheduleItems).values({ id: id("ivs"), tenantId: investment.tenantId, investmentId: investment.id, number: (last?.number ?? 0) + 1, ...fields.values, createdByUserId: scope.user.id });
    await audit(tx, scope, ...(await recordScheduleRevision(tx, scope.user.id, context, [...itemValues(context.items), fields.values], "Pagamento incluído no cronograma")));
    return { ok: true, message: "Pagamento incluído no cronograma.", id: investment.id };
  });
  if (result.ok) refresh();
  return result;
}

export async function updateInvestmentScheduleItemAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  const itemId = read("itemId", 80);
  if (!investmentId || !itemId) return { ok: false, error: "Pagamento inválido." };
  const fields = scheduleItemFields(read);
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const context = await lockSchedule(tx, scope, investmentId);
    if ("ok" in context) return context;
    const item = context.items.find((row) => row.id === itemId);
    if (!item) return { ok: false, error: "Pagamento não encontrado neste cronograma." };
    if ((await cashOf(tx, context.investment)).paidItemIds.has(item.id)) return PAID_ITEM_ERROR;
    const dates = datesProblem(context.investment, [fields.values]);
    if (dates) return dates;
    const overflow = principalOverflow(context.investment, context.items.map((row) => (row.id === item.id ? fields.values : row)));
    if (overflow) return overflow;
    await tx.update(investmentScheduleItems).set({ ...fields.values, updatedAt: sql`now()` }).where(and(eq(investmentScheduleItems.id, item.id), eq(investmentScheduleItems.tenantId, item.tenantId)));
    await audit(tx, scope, ...(await recordScheduleRevision(tx, scope.user.id, context, itemValues(context.items).map((row, index) => (context.items[index].id === item.id ? fields.values : row)), "Pagamento do cronograma alterado")));
    return { ok: true, message: "Pagamento do cronograma alterado.", id: context.investment.id };
  });
  if (result.ok) refresh();
  return result;
}

export async function deleteInvestmentScheduleItemAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  const itemId = read("itemId", 80);
  if (!investmentId || !itemId) return { ok: false, error: "Pagamento inválido." };
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const context = await lockSchedule(tx, scope, investmentId);
    if ("ok" in context) return context;
    const item = context.items.find((row) => row.id === itemId);
    if (!item) return { ok: false, error: "Pagamento não encontrado neste cronograma." };
    if ((await cashOf(tx, context.investment)).paidItemIds.has(item.id)) return PAID_ITEM_ERROR;
    await tx.delete(investmentScheduleItems).where(and(eq(investmentScheduleItems.id, item.id), eq(investmentScheduleItems.tenantId, item.tenantId)));
    await audit(tx, scope, ...(await recordScheduleRevision(tx, scope.user.id, context, itemValues(context.items.filter((row) => row.id !== item.id)), "Pagamento retirado do cronograma")));
    return { ok: true, message: "Pagamento retirado do cronograma.", id: context.investment.id };
  });
  if (result.ok) refresh();
  return result;
}

// Documentos do investimento: PDF ou imagem de até 5 MB, como os documentos de clientes (guardados no banco).
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const documentTypes: Record<string, (bytes: Buffer) => boolean> = {
  "application/pdf": (bytes) => bytes.subarray(0, 5).toString("latin1") === "%PDF-",
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
};

async function readDocumentFile(data: FormData) {
  const file = data.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false as const, error: "Escolha o arquivo do documento." };
  if (file.size > MAX_DOCUMENT_BYTES) return { ok: false as const, error: "O arquivo pode ter no máximo 5 MB." };
  const content = Buffer.from(await file.arrayBuffer());
  // O tipo é conferido pelo conteúdo do arquivo, não só pela extensão.
  const contentType = Object.keys(documentTypes).find((type) => documentTypes[type](content));
  if (!contentType) return { ok: false as const, error: "Envie um PDF ou uma imagem (JPG, PNG ou WEBP)." };
  const fileName = file.name.replace(/[\\/\r\n"]/g, "_").slice(0, 160) || "documento";
  return { ok: true as const, content, contentType, fileName };
}

// Contrato assinado: a versão gerada pelo sistema que foi assinada. Precisa ser do mesmo investimento (e tenant).
// "" = contrato não gerado pelo sistema. Campo ausente = undefined (na substituição, mantém o vínculo anterior).
async function signedContractVersion(tx: TenantTransaction, data: FormData, investment: { id: string; tenantId: string }) {
  if (!data.has("contractId")) return { ok: true as const, contractId: undefined, version: undefined };
  const contractId = String(data.get("contractId") ?? "").trim().slice(0, 80);
  if (!contractId) return { ok: true as const, contractId: null, version: null };
  const [contract] = await tx.select({ id: investmentContracts.id, version: investmentContracts.version }).from(investmentContracts)
    .where(and(eq(investmentContracts.id, contractId), eq(investmentContracts.investmentId, investment.id), eq(investmentContracts.tenantId, investment.tenantId)));
  if (!contract) return { ok: false as const, error: "Escolha uma versão do contrato deste investimento." };
  return { ok: true as const, contractId: contract.id, version: contract.version };
}

const fileSnapshot = (file: { kind: string; fileName: string; contentType: string; sizeBytes: number }) =>
  ({ kind: file.kind, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.sizeBytes });

export async function uploadInvestmentDocumentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  const kind = parseDocumentKind(read("kind", 40));
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  if (!kind) return { ok: false, error: "Escolha o tipo do documento." };
  const file = await readDocumentFile(data);
  if (!file.ok) return file;
  let result: InvestorActionResult;
  try {
    result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
      const [investment] = await tx.select().from(investments).where(and(eq(investments.id, investmentId), tenantFilter(scope, investments.tenantId)));
      if (!investment) return { ok: false, error: "Investimento não encontrado." };
      if (kind === "SIGNED_CONTRACT") {
        const [existing] = await tx.select({ id: investmentDocuments.id }).from(investmentDocuments)
          .where(and(eq(investmentDocuments.investmentId, investment.id), eq(investmentDocuments.tenantId, investment.tenantId), eq(investmentDocuments.kind, "SIGNED_CONTRACT"), isNull(investmentDocuments.replacedAt)));
        if (existing) return SIGNED_CONTRACT_ERROR;
      }
      const link = kind === "SIGNED_CONTRACT" ? await signedContractVersion(tx, data, investment) : { ok: true as const, contractId: null, version: null };
      if (!link.ok) return link;
      const documentId = id("idoc");
      const values = { kind, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.content.length };
      await tx.insert(investmentDocuments).values({ id: documentId, tenantId: investment.tenantId, investmentId: investment.id, ...values, contractId: link.contractId ?? null, content: file.content, uploadedByUserId: scope.user.id });
      await audit(tx, scope, investment.tenantId, "INVESTMENT_DOCUMENT_UPLOADED", "investment_document", documentId, null,
        { investmentId: investment.id, ...fileSnapshot(values), ...(kind === "SIGNED_CONTRACT" ? { contractId: link.contractId ?? null, contractVersion: link.version ?? null } : {}) },
        `${DOCUMENT_KINDS[kind]} enviado (${file.fileName})${link.version ? ` – assinatura da versão ${link.version} do contrato gerado` : ""}`);
      return { ok: true, message: `${DOCUMENT_KINDS[kind]} enviado.`, id: documentId };
    });
  } catch (error) {
    if (duplicateSignedContract(error)) return SIGNED_CONTRACT_ERROR;
    throw error;
  }
  if (result.ok) refresh();
  return result;
}

// Substituir: a nova versão passa a valer e a anterior fica no histórico (nunca é apagada).
export async function replaceInvestmentDocumentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const documentId = read("documentId", 80);
  if (!documentId) return { ok: false, error: "Documento inválido." };
  const file = await readDocumentFile(data);
  if (!file.ok) return file;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const [previous] = await tx.select({
      id: investmentDocuments.id, tenantId: investmentDocuments.tenantId, investmentId: investmentDocuments.investmentId, kind: investmentDocuments.kind,
      fileName: investmentDocuments.fileName, contentType: investmentDocuments.contentType, sizeBytes: investmentDocuments.sizeBytes, replacedAt: investmentDocuments.replacedAt,
      contractId: investmentDocuments.contractId,
    }).from(investmentDocuments).where(and(eq(investmentDocuments.id, documentId), tenantFilter(scope, investmentDocuments.tenantId)));
    if (!previous) return { ok: false, error: "Documento não encontrado." };
    if (previous.replacedAt) return { ok: false, error: "Esta versão já foi substituída. Substitua a versão atual." };
    const link = previous.kind === "SIGNED_CONTRACT" ? await signedContractVersion(tx, data, { id: previous.investmentId, tenantId: previous.tenantId }) : { ok: true as const, contractId: null, version: null };
    if (!link.ok) return link;
    const contractId = link.contractId === undefined ? previous.contractId : link.contractId;
    const newId = id("idoc");
    // Primeiro marca a anterior como substituída (o índice só aceita um contrato assinado vigente), depois grava a nova.
    // Se outra substituição simultânea chegou antes, nada é marcado e esta não grava uma segunda versão vigente.
    const marked = await tx.update(investmentDocuments).set({ replacedAt: sql`now()`, replacedByDocumentId: newId })
      .where(and(eq(investmentDocuments.id, previous.id), eq(investmentDocuments.tenantId, previous.tenantId), isNull(investmentDocuments.replacedAt)))
      .returning({ id: investmentDocuments.id });
    if (marked.length === 0) return { ok: false, error: "Esta versão já foi substituída. Substitua a versão atual." };
    const values = { kind: previous.kind, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.content.length };
    await tx.insert(investmentDocuments).values({ id: newId, tenantId: previous.tenantId, investmentId: previous.investmentId, ...values, contractId, content: file.content, uploadedByUserId: scope.user.id });
    const kindLabel = DOCUMENT_KINDS[previous.kind as keyof typeof DOCUMENT_KINDS] ?? "Documento";
    await audit(tx, scope, previous.tenantId, "INVESTMENT_DOCUMENT_REPLACED", "investment_document", newId,
      { investmentId: previous.investmentId, ...fileSnapshot(previous), ...(previous.kind === "SIGNED_CONTRACT" ? { contractId: previous.contractId } : {}) },
      { investmentId: previous.investmentId, replacedDocumentId: previous.id, ...fileSnapshot(values), ...(previous.kind === "SIGNED_CONTRACT" ? { contractId } : {}) },
      `${kindLabel} substituído (${previous.fileName} → ${file.fileName})`);
    return { ok: true, message: `${kindLabel} substituído. A versão anterior continua no histórico.`, id: newId };
  });
  if (result.ok) refresh();
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Contrato de investimento gerado pelo sistema. O PDF gerado não é assinado: o usuário baixa, envia ao investidor por
// conta própria e depois anexa a versão assinada em Documentos (Contrato assinado), indicando a versão correspondente.

// Lê o investimento no escopo da sessão, com o investidor (sempre do mesmo tenant).
async function investmentInScope(tx: TenantTransaction, scope: Parameters<typeof tenantFilter>[0], investmentId: string, lock = false) {
  const query = tx.select({ investment: investments, investor: investors }).from(investments)
    .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
    .where(and(eq(investments.id, investmentId), tenantFilter(scope, investments.tenantId)));
  // FOR UPDATE do investimento: duas gerações simultâneas do mesmo contrato ficam em fila (versões sem buraco nem duplicata).
  const [row] = lock ? await query.for("update", { of: investments }) : await query;
  return row ?? null;
}

// Dados da empresa contratante (um cadastro por carteira, usado em todos os contratos dela).
export async function saveContractorAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  const fields = contractorFields(read);
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const row = await investmentInScope(tx, scope, investmentId);
    if (!row) return { ok: false, error: "Investimento não encontrado." };
    // O tenant é sempre o do investimento (para o usuário comum, a própria carteira): nunca vem do formulário.
    const tenantId = row.investment.tenantId;
    const previous = await loadContractor(tx, tenantId);
    const { address, confirmed, ...rest } = fields.values;
    const values = {
      ...rest, addressCep: address.Cep, addressStreet: address.Street, addressNumber: address.Number, addressComplement: address.Complement,
      addressDistrict: address.District, addressCity: address.City, addressState: address.State,
      confirmedAt: confirmed ? sql`now()` : null, confirmedByUserId: confirmed ? scope.user.id : null, updatedByUserId: scope.user.id, updatedAt: sql`now()`,
    };
    await tx.insert(investmentContractors).values({ tenantId, ...values }).onConflictDoUpdate({ target: investmentContractors.tenantId, set: values });
    const snapshot = (source: { legalName: string | null; document: string | null; addressCity: string | null; addressState: string | null; representativeName: string | null } & Record<string, unknown>, isConfirmed: boolean) => ({
      legalName: source.legalName, document: source.document, address: [source.addressStreet, source.addressNumber, source.addressDistrict, source.addressCity, source.addressState, source.addressCep].filter(Boolean).join(", ") || null,
      representativeName: source.representativeName, representativeDocument: source.representativeDocument ? "preenchido" : null, confirmed: isConfirmed,
    });
    await audit(tx, scope, tenantId, "INVESTMENT_CONTRACTOR_UPDATED", "investment_contractor", tenantId,
      previous ? snapshot(previous, Boolean(previous.confirmedAt)) : null, snapshot({ ...values, legalName: rest.legalName, document: rest.document, representativeName: rest.representativeName }, confirmed),
      confirmed ? "Dados da empresa contratante confirmados" : "Dados da empresa contratante salvos sem confirmação");
    return { ok: true, message: confirmed ? "Dados da empresa contratante salvos e confirmados." : "Dados salvos. Confirme-os para poder gerar o contrato." };
  });
  if (result.ok) refresh();
  return result;
}

// Gera a primeira versão do contrato ou uma nova versão. A versão anterior fica no histórico (substituída) e nenhum
// documento assinado é tocado. Faltando dado essencial, nada é gerado e a mensagem diz o que falta.
export async function generateContractAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investmentId = read("investmentId", 80);
  if (!investmentId) return { ok: false, error: "Investimento inválido." };
  const includeNotes = read("includeNotes", 4) === "1";
  const confirmSignedKept = read("confirmSignedKept", 4) === "1";
  const fonts = await contractFonts();
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const row = await investmentInScope(tx, scope, investmentId, true);
    if (!row) return { ok: false, error: "Investimento não encontrado." };
    const { investment, investor } = row;
    const source = contractSource(investment, investor, await loadContractor(tx, investment.tenantId));
    const missing = missingContractData(source, includeNotes);
    if (missing.length) return { ok: false, error: `Não é possível gerar a versão final do contrato. Falta: ${missing.map((item) => `${item.section}: ${item.item}`).join("; ")}.` };

    const [current] = await tx.select().from(investmentContracts)
      .where(and(eq(investmentContracts.investmentId, investment.id), eq(investmentContracts.tenantId, investment.tenantId), isNull(investmentContracts.supersededAt)));
    const dataHash = contractDataHash(source, includeNotes);
    if (current && current.dataHash === dataHash) return { ok: false, error: `Os dados não mudaram desde a versão ${current.version}. Use a versão atual ou altere os dados antes de gerar outra.` };
    // Já existe contrato assinado vigente: a nova versão não o substitui, e o usuário precisa confirmar que entendeu.
    const [signed] = await tx.select({ id: investmentDocuments.id }).from(investmentDocuments)
      .where(and(eq(investmentDocuments.investmentId, investment.id), eq(investmentDocuments.tenantId, investment.tenantId), eq(investmentDocuments.kind, "SIGNED_CONTRACT"), isNull(investmentDocuments.replacedAt)));
    if (signed && !confirmSignedKept) return { ok: false, error: "Este investimento já tem contrato assinado. Confirme que a nova versão não substitui o contrato assinado (ele continua em Documentos) e precisa ser assinada à parte." };

    const [{ last }] = await tx.select({ last: sql<number>`coalesce(max(${investmentContracts.version}), 0)::int` }).from(investmentContracts)
      .where(and(eq(investmentContracts.investmentId, investment.id), eq(investmentContracts.tenantId, investment.tenantId)));
    const version = Number(last) + 1;
    const generatedAt = new Date();
    const pdf = Buffer.from(await renderContractPdf(buildContract(source, includeNotes, { version, generatedAt }), generatedAt, fonts));
    const contractId = id("ictr");
    const fileName = contractFileName(investor.name, version);
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    // Primeiro marca a versão vigente como substituída (o índice só aceita uma vigente), depois grava a nova.
    if (current) {
      await tx.update(investmentContracts).set({ supersededAt: sql`now()`, supersededByContractId: contractId })
        .where(and(eq(investmentContracts.id, current.id), eq(investmentContracts.tenantId, current.tenantId), isNull(investmentContracts.supersededAt)));
    }
    await tx.insert(investmentContracts).values({
      id: contractId, tenantId: investment.tenantId, investmentId: investment.id, version, templateVersion: CONTRACT_TEMPLATE_VERSION, dataHash, includesNotes: includeNotes,
      fileName, sizeBytes: pdf.length, sha256, content: pdf, generatedByUserId: scope.user.id, createdAt: generatedAt,
    });
    // Auditoria sem dados pessoais: versão, arquivo, hash e o vínculo com o investimento.
    await audit(tx, scope, investment.tenantId, "INVESTMENT_CONTRACT_GENERATED", "investment_contract", contractId,
      current ? { investmentId: investment.id, version: current.version, contractId: current.id } : null,
      { investmentId: investment.id, version, fileName, sizeBytes: pdf.length, sha256, templateVersion: CONTRACT_TEMPLATE_VERSION, includesNotes: includeNotes, signedContractKept: Boolean(signed) },
      current ? `Nova versão do contrato gerada (versão ${version}, substitui a versão ${current.version})` : `Contrato gerado (versão ${version})`);
    return { ok: true, message: current ? `Versão ${version} do contrato gerada. A versão ${current.version} continua no histórico.` : "Contrato gerado (versão 1). Baixe o PDF e envie para assinatura.", id: contractId };
  });
  if (result.ok) refresh();
  return result;
}

// Registro manual de que a versão vigente foi enviada para assinatura (o envio acontece fora do sistema).
export async function markContractSentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const contractId = read("contractId", 80);
  if (!contractId) return { ok: false, error: "Contrato inválido." };
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const [contract] = await tx.select({ id: investmentContracts.id, tenantId: investmentContracts.tenantId, investmentId: investmentContracts.investmentId, version: investmentContracts.version, sentAt: investmentContracts.sentAt, supersededAt: investmentContracts.supersededAt })
      .from(investmentContracts).where(and(eq(investmentContracts.id, contractId), tenantFilter(scope, investmentContracts.tenantId)));
    if (!contract) return { ok: false, error: "Contrato não encontrado." };
    if (contract.supersededAt) return { ok: false, error: "Esta versão foi substituída. Envie a versão atual." };
    if (contract.sentAt) return { ok: false, error: "Esta versão já está marcada como enviada." };
    await tx.update(investmentContracts).set({ sentAt: sql`now()`, sentByUserId: scope.user.id })
      .where(and(eq(investmentContracts.id, contract.id), eq(investmentContracts.tenantId, contract.tenantId), isNull(investmentContracts.sentAt)));
    await audit(tx, scope, contract.tenantId, "INVESTMENT_CONTRACT_SENT", "investment_contract", contract.id, { investmentId: contract.investmentId, version: contract.version, sent: false },
      { investmentId: contract.investmentId, version: contract.version, sent: true }, `Versão ${contract.version} do contrato marcada como enviada para assinatura`);
    return { ok: true, message: `Versão ${contract.version} marcada como enviada para assinatura.` };
  });
  if (result.ok) refresh();
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Contas bancárias do investidor (migração 0024). A auditoria nunca recebe os números: só o que mudou, em nomes de campo.

const BANK_FIELD_LABELS: Record<keyof BankAccountValues, string> = {
  bankCode: "Código do banco", bankName: "Banco", branch: "Agência", branchDigit: "Dígito da agência", account: "Conta", accountDigit: "Dígito da conta",
  accountType: "Tipo de conta", holderName: "Titular", holderDocument: "CPF/CNPJ do titular", pixKeyType: "Tipo da chave Pix", pixKey: "Chave Pix",
  isPreferred: "Conta preferencial", notes: "Observações da conta",
};
const changedBankFields = (before: BankAccountValues | null, after: BankAccountValues) =>
  (Object.keys(BANK_FIELD_LABELS) as (keyof BankAccountValues)[]).filter((key) => (before?.[key] ?? null) !== (after[key] ?? null)).map((key) => BANK_FIELD_LABELS[key]);

// Investidor no escopo da sessão, travado (FOR NO KEY UPDATE): contas e documentos dele entram em fila, e a troca da
// conta preferencial não cruza com outra.
async function investorInScope(tx: TenantTransaction, scope: Parameters<typeof tenantFilter>[0], investorId: string) {
  const [row] = await tx.select().from(investors).where(and(eq(investors.id, investorId), tenantFilter(scope, investors.tenantId))).for("no key update");
  return row ?? null;
}

export async function saveInvestorBankAccountAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investorId = read("investorId", 80);
  const accountId = read("accountId", 80);
  if (!investorId) return { ok: false, error: "Investidor inválido." };
  const fields = bankAccountFields(read);
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const investor = await investorInScope(tx, scope, investorId);
    if (!investor) return { ok: false, error: "Investidor não encontrado." };
    const accounts = await tx.select().from(investorBankAccounts)
      .where(and(eq(investorBankAccounts.investorId, investor.id), eq(investorBankAccounts.tenantId, investor.tenantId))).for("update");
    const current = accountId ? accounts.find((account) => account.id === accountId) : null;
    if (accountId && !current) return { ok: false, error: "Conta bancária não encontrada." };
    if (current?.archivedAt) return { ok: false, error: "Esta conta foi retirada e não pode ser alterada." };
    // Conta ligada a um contrato: o que ela é (banco/agência/conta/chave) não muda mais, para preservar o histórico; o
    // titular, as observações e a preferência podem mudar.
    if (current) {
      const [linked] = await tx.select({ id: investments.id }).from(investments).where(and(eq(investments.tenantId, investor.tenantId), eq(investments.bankAccountId, current.id))).limit(1);
      const identity: (keyof BankAccountValues)[] = ["bankCode", "bankName", "branch", "branchDigit", "account", "accountDigit", "pixKeyType", "pixKey"];
      if (linked && identity.some((key) => (current[key] ?? null) !== (fields.values[key] ?? null))) {
        return { ok: false, error: "Esta conta está ligada a um contrato: banco, agência, conta e chave Pix não podem mais ser alterados. Cadastre uma nova conta e escolha-a no contrato." };
      }
    }
    const active = accounts.filter((account) => !account.archivedAt);
    // A primeira conta do investidor é a preferencial; marcar outra como preferencial tira a marca da anterior.
    const isPreferred = fields.values.isPreferred || active.length === 0 || (current?.isPreferred ?? false);
    if (isPreferred) {
      await tx.update(investorBankAccounts).set({ isPreferred: false, updatedAt: sql`now()` })
        .where(and(eq(investorBankAccounts.investorId, investor.id), eq(investorBankAccounts.tenantId, investor.tenantId), eq(investorBankAccounts.isPreferred, true), accountId ? ne(investorBankAccounts.id, accountId) : undefined));
    }
    const values = { ...fields.values, isPreferred };
    const savedId = current?.id ?? id("iba");
    if (current) {
      await tx.update(investorBankAccounts).set({ ...values, updatedAt: sql`now()` }).where(and(eq(investorBankAccounts.id, current.id), eq(investorBankAccounts.tenantId, investor.tenantId)));
    } else {
      await tx.insert(investorBankAccounts).values({ id: savedId, tenantId: investor.tenantId, investorId: investor.id, ...values, createdByUserId: scope.user.id });
    }
    const changed = changedBankFields(current ? { ...current, accountType: current.accountType as BankAccountValues["accountType"], pixKeyType: current.pixKeyType as BankAccountValues["pixKeyType"] } : null, values);
    await audit(tx, scope, investor.tenantId, current ? "INVESTOR_BANK_ACCOUNT_UPDATED" : "INVESTOR_BANK_ACCOUNT_CREATED", "investor_bank_account", savedId,
      current ? { investorId: investor.id, preferred: current.isPreferred } : null,
      { investorId: investor.id, preferred: isPreferred, changedFields: changed.join(", ") || null, hasBankAccount: Boolean(values.account), hasPix: Boolean(values.pixKey) },
      `${current ? "Conta bancária alterada" : "Conta bancária cadastrada"} para ${investor.name}`);
    return { ok: true, message: current ? "Conta bancária atualizada." : "Conta bancária cadastrada.", id: savedId };
  });
  if (result.ok) refresh();
  return result;
}

// Retirar uma conta: ela fica arquivada (nunca é apagada). Conta escolhida em contrato que não está encerrado nem
// cancelado não pode ser retirada.
export async function archiveInvestorBankAccountAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investorId = read("investorId", 80);
  const accountId = read("accountId", 80);
  if (!investorId || !accountId) return { ok: false, error: "Conta bancária inválida." };
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const investor = await investorInScope(tx, scope, investorId);
    if (!investor) return { ok: false, error: "Investidor não encontrado." };
    const [account] = await tx.select().from(investorBankAccounts)
      .where(and(eq(investorBankAccounts.id, accountId), eq(investorBankAccounts.investorId, investor.id), eq(investorBankAccounts.tenantId, investor.tenantId))).for("update");
    if (!account) return { ok: false, error: "Conta bancária não encontrada." };
    if (account.archivedAt) return { ok: false, error: "Esta conta já foi retirada." };
    const [linked] = await tx.select({ id: investments.id }).from(investments)
      .where(and(eq(investments.tenantId, investor.tenantId), eq(investments.bankAccountId, account.id), sql`${investments.status} not in ('CLOSED', 'CANCELED')`)).limit(1);
    if (linked) return { ok: false, error: "Esta conta está escolhida em um contrato em vigor. Troque a conta no contrato antes de retirá-la." };
    await tx.update(investorBankAccounts).set({ archivedAt: sql`now()`, isPreferred: false, updatedAt: sql`now()` })
      .where(and(eq(investorBankAccounts.id, account.id), eq(investorBankAccounts.tenantId, investor.tenantId)));
    await audit(tx, scope, investor.tenantId, "INVESTOR_BANK_ACCOUNT_ARCHIVED", "investor_bank_account", account.id, { investorId: investor.id, archived: false }, { investorId: investor.id, archived: true },
      `Conta bancária de ${investor.name} retirada (fica no histórico)`);
    return { ok: true, message: "Conta bancária retirada. Ela continua no histórico." };
  });
  if (result.ok) refresh();
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Documentos do investidor (identidade, comprovantes, contrato social). PDF ou imagem de até 5 MB, conferidos pelo
// conteúdo. Retirar não apaga o arquivo: removed_at marca quando e por quem.

export async function uploadInvestorDocumentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const investorId = read("investorId", 80);
  const kind = parseInvestorDocumentKind(read("kind", 40));
  if (!investorId) return { ok: false, error: "Investidor inválido." };
  if (!kind) return { ok: false, error: "Escolha o tipo do documento." };
  const label = read("label", 120) || null;
  const file = await readDocumentFile(data);
  if (!file.ok) return file;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const investor = await investorInScope(tx, scope, investorId);
    if (!investor) return { ok: false, error: "Investidor não encontrado." };
    const documentId = id("idd");
    const values = { kind, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.content.length };
    await tx.insert(investorDocuments).values({ id: documentId, tenantId: investor.tenantId, investorId: investor.id, label, ...values, content: file.content, uploadedByUserId: scope.user.id });
    await audit(tx, scope, investor.tenantId, "INVESTOR_DOCUMENT_UPLOADED", "investor_document", documentId, null, { investorId: investor.id, ...fileSnapshot(values) },
      `${INVESTOR_DOCUMENT_KINDS[kind]} de ${investor.name} enviado (${file.fileName})`);
    return { ok: true, message: `${INVESTOR_DOCUMENT_KINDS[kind]} enviado.`, id: documentId };
  });
  if (result.ok) refresh();
  return result;
}

export async function removeInvestorDocumentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const documentId = read("documentId", 80);
  if (!documentId) return { ok: false, error: "Documento inválido." };
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const [document] = await tx.select({ id: investorDocuments.id, tenantId: investorDocuments.tenantId, investorId: investorDocuments.investorId, kind: investorDocuments.kind, fileName: investorDocuments.fileName, contentType: investorDocuments.contentType, sizeBytes: investorDocuments.sizeBytes })
      .from(investorDocuments).where(and(eq(investorDocuments.id, documentId), tenantFilter(scope, investorDocuments.tenantId), isNull(investorDocuments.removedAt)));
    if (!document) return { ok: false, error: "Documento não encontrado." };
    const marked = await tx.update(investorDocuments).set({ removedAt: sql`now()`, removedByUserId: scope.user.id })
      .where(and(eq(investorDocuments.id, document.id), eq(investorDocuments.tenantId, document.tenantId), isNull(investorDocuments.removedAt))).returning({ id: investorDocuments.id });
    if (marked.length === 0) return { ok: false, error: "Este documento já foi retirado." };
    await audit(tx, scope, document.tenantId, "INVESTOR_DOCUMENT_REMOVED", "investor_document", document.id, { investorId: document.investorId, ...fileSnapshot(document), removed: false }, { investorId: document.investorId, removed: true },
      `Documento do investidor retirado (${document.fileName}); o arquivo continua no histórico`);
    return { ok: true, message: "Documento retirado. Ele continua no histórico." };
  });
  if (result.ok) refresh();
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Renovação explícita de um contrato (migração 0024). Cria um contrato NOVO, ligado ao anterior, com o novo prazo, taxa,
// condições e (depois) cronograma. O valor é o principal ainda não devolvido do anterior, que passa para o novo sem
// nova entrada no capital. O anterior fica encerrado, com todo o histórico; rendimentos pendentes nele continuam
// podendo ser pagos, mas a devolução de principal passa a ser feita no contrato novo. O banco confere tudo de novo.
export async function renewInvestmentAction(data: FormData): Promise<InvestorActionResult> {
  const read = reader(data);
  const previousId = read("investmentId", 80);
  if (!previousId) return { ok: false, error: "Investimento inválido." };
  if (read("confirm", 4) !== "1") return { ok: false, error: "Confirme a renovação: o contrato atual será encerrado e o principal passará para o novo contrato." };
  const shownAmount = Number(read("principalCents", 20));
  // O valor do contrato novo não vem do formulário: é o principal ainda não devolvido, conferido abaixo.
  const fields = investmentFields((key, max) => (key === "amount" ? "1" : read(key, max)));
  if (!fields.ok) return fields;
  const result = await withInvestorContext(async (tx, scope): Promise<InvestorActionResult> => {
    const [row] = await tx.select({ investment: investments, investorName: investors.name, investorStatus: investors.status }).from(investments)
      .innerJoin(investors, and(eq(investors.id, investments.investorId), eq(investors.tenantId, investments.tenantId)))
      .where(and(eq(investments.id, previousId), tenantFilter(scope, investments.tenantId))).for("no key update", { of: investments });
    if (!row) return { ok: false, error: "Investimento não encontrado." };
    const previous = row.investment;
    if (previous.status !== "ACTIVE" && previous.status !== "CLOSED") return { ok: false, error: "Só um contrato ativo ou encerrado pode ser renovado." };
    const [already] = await tx.select({ id: investments.id }).from(investments).where(and(eq(investments.renewedFromInvestmentId, previous.id), eq(investments.tenantId, previous.tenantId)));
    if (already) return { ok: false, error: "Este contrato já foi renovado. Renove o contrato novo, se for o caso." };
    const [{ hasCapital }] = await tx.select({ hasCapital: sql<boolean>`crediai_investment_has_capital(${previous.tenantId}, ${previous.id})` }).from(investments)
      .where(and(eq(investments.id, previous.id), eq(investments.tenantId, previous.tenantId)));
    if (!hasCapital) return { ok: false, error: "O dinheiro deste contrato ainda não está registrado no capital (entrada ou aporte anterior). Registre-o antes de renovar." };
    const [{ returned }] = await tx.select({ returned: sql<string>`coalesce(sum(${investmentPayments.amountCents}), 0)` }).from(investmentPayments)
      .where(and(eq(investmentPayments.investmentId, previous.id), eq(investmentPayments.tenantId, previous.tenantId), eq(investmentPayments.kind, "PRINCIPAL")));
    const remaining = previous.amountCents - Number(returned);
    if (remaining <= 0) return { ok: false, error: "Todo o principal deste contrato já foi devolvido: não há o que renovar." };
    if (shownAmount !== remaining) return { ok: false, error: "O principal a renovar mudou desde que o formulário foi aberto (houve uma baixa). Confira e confirme de novo. Nada foi gravado." };
    if (fields.values.startDate < previous.startDate) return { ok: false, error: `A renovação não pode começar antes do início do contrato anterior (${formatDate(previous.startDate)}).` };
    const values: InvestmentValues = { ...fields.values, amountCents: remaining, investedOn: null };
    const account = await checkBankAccount(tx, { id: previous.investorId, tenantId: previous.tenantId }, values);
    if (!account.ok) return account;
    const newId = id("ivt");
    await tx.insert(investments).values({ id: newId, tenantId: previous.tenantId, investorId: previous.investorId, ...values, renewedFromInvestmentId: previous.id, createdByUserId: scope.user.id });
    const label = (investment: { contractNumber: string | null; startDate: string }) => investment.contractNumber ? `contrato ${investment.contractNumber}` : `contrato iniciado em ${formatDate(investment.startDate)}`;
    if (previous.status === "ACTIVE") {
      await tx.update(investments).set({ status: "CLOSED", updatedAt: sql`now()` }).where(and(eq(investments.id, previous.id), eq(investments.tenantId, previous.tenantId)));
    }
    await tx.insert(investmentRevisions).values([
      { id: id("ivr"), tenantId: previous.tenantId, investmentId: previous.id, kind: "CONTRACT", description: "Contrato renovado",
        changes: [{ field: "Renovação", before: null, after: `${formatMoney(remaining)} de principal passaram para o ${label(values)}` }, ...(previous.status === "ACTIVE" ? [{ field: "Status", before: "Ativo", after: "Encerrado" }] : [])], changedByUserId: scope.user.id },
      { id: id("ivr"), tenantId: previous.tenantId, investmentId: newId, kind: "CONTRACT", description: "Contrato criado por renovação",
        changes: [{ field: "Renovação de", before: null, after: `${label(previous)} (${formatMoney(previous.amountCents)})` }], changedByUserId: scope.user.id },
    ]);
    await audit(tx, scope, previous.tenantId, "INVESTMENT_RENEWED", "investment", newId, { investmentId: previous.id, status: previous.status, amountCents: previous.amountCents, principalReturnedCents: Number(returned) },
      { investmentId: newId, renewedFrom: previous.id, ...investmentSnapshot(values), previousStatus: "CLOSED" }, `Contrato de ${row.investorName} renovado (${formatMoney(remaining)} de principal)`);
    return { ok: true, message: `Contrato renovado: ${formatMoney(remaining)} de principal passaram para o novo contrato. Monte o cronograma dele.`, id: newId };
  }).catch((error) => {
    if (duplicateContractNumber(error)) return CONTRACT_NUMBER_ERROR;
    if (violates(/investment_renewed_from_unique/)(error)) return { ok: false as const, error: "Este contrato já foi renovado." };
    throw error;
  });
  if (result.ok) refresh();
  return result;
}
