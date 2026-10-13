// Módulo Financeiro: regras puras (sem banco) das entradas e saídas manuais e do extrato financeiro.
//
// Fonte única da verdade do saldo: o capital disponível continua sendo calculado só por buildPortfolio (portfolio.ts)
// a partir de capital inicial (wallet), movimentos de capital (capital_movement), principal das operações e pagamentos.
// O Financeiro não guarda saldo nem duplica nada: uma entrada ou saída manual é UMA linha em capital_movement (valor
// sempre positivo, tipo explícito); empréstimos e recebimentos continuam vindo das tabelas de operações e pagamentos e só
// são exibidos no extrato.
import { formatDate, formatMoney, isIsoDate, parseMoneyToCents } from "./format";
import { capitalLedgerLabels, type CapitalLedgerEntry, type CapitalMovementKind } from "./portfolio";

export type FinanceDirection = "IN" | "OUT";
export const directionLabels: Record<FinanceDirection, string> = { IN: "Entrada", OUT: "Saída" };

// Sinal de cada tipo de movimento no capital disponível. Só estes dois tipos somam; todos os outros subtraem.
export const INFLOW_KINDS = ["CONTRIBUTION", "OTHER_INCOME"] as const satisfies readonly CapitalMovementKind[];
export const movementSign = (kind: CapitalMovementKind) => ((INFLOW_KINDS as readonly string[]).includes(kind) ? 1 : -1);

// Categorias dos lançamentos manuais e o tipo de movimento gravado para cada uma. "Aporte de capital" grava o mesmo
// CONTRIBUTION da tela Capital: é o mesmo aporte, não uma segunda entrada.
export const manualCategories = {
  CAPITAL_CONTRIBUTION: { label: "Aporte de capital", direction: "IN", kind: "CONTRIBUTION" },
  OTHER_INCOME: { label: "Outras entradas", direction: "IN", kind: "OTHER_INCOME" },
  SALARY_WITHDRAWAL: { label: "Retirada de salário", direction: "OUT", kind: "WITHDRAWAL" },
  PARTNER_WITHDRAWAL: { label: "Retirada de sócio", direction: "OUT", kind: "WITHDRAWAL" },
  OPERATING_EXPENSE: { label: "Despesa operacional", direction: "OUT", kind: "WITHDRAWAL" },
  TAXES_AND_FEES: { label: "Impostos e taxas", direction: "OUT", kind: "WITHDRAWAL" },
  OTHER_OUTFLOW: { label: "Outras saídas", direction: "OUT", kind: "WITHDRAWAL" },
} as const satisfies Record<string, { label: string; direction: FinanceDirection; kind: CapitalMovementKind }>;
export type ManualCategory = keyof typeof manualCategories;
export const isManualCategory = (value: string): value is ManualCategory => Object.hasOwn(manualCategories, value);
export const categoriesOf = (direction: FinanceDirection) => (Object.keys(manualCategories) as ManualCategory[]).filter((key) => manualCategories[key].direction === direction);

// Categorias do extrato: as manuais e as dos lançamentos que outros módulos já fazem (só exibidos aqui).
export const statementCategoryLabels = {
  ...Object.fromEntries(Object.entries(manualCategories).map(([key, value]) => [key, value.label])) as Record<ManualCategory, string>,
  INITIAL_CAPITAL: "Capital inicial",
  LOAN: "Empréstimo concedido",
  LOAN_CANCELED: "Devolução de operação excluída",
  PAYMENT: "Recebimento de operação",
  CONTRIBUTION_REVERSAL: "Estorno de aporte",
  LEGACY_WITHDRAWAL: "Retirada (sem categoria)",
} as const;
export type StatementCategory = keyof typeof statementCategoryLabels;
export const isStatementCategory = (value: string): value is StatementCategory => Object.hasOwn(statementCategoryLabels, value);

export const DESCRIPTION_MAX = 200;
export const NOTES_MAX = 500;
const MAX_CENTS = 100_000_000_000; // mesmo limite técnico das outras telas (R$ 1 bilhão)

export type ManualMovementInput = { direction: string; category: string; amount: string; occurredAt: string; description: string; notes: string; requestId: string };
export type ManualMovement = { direction: FinanceDirection; category: ManualCategory; kind: CapitalMovementKind; amountCents: number; occurredAt: string; description: string; notes: string | null; requestId: string };

// Confere um lançamento manual antes de qualquer acesso ao banco. A data não pode ser futura nem anterior ao início do
// ciclo atual da carteira (o extrato e os cards só enxergam o ciclo atual; um lançamento fora dele sumiria do saldo).
export function parseManualMovement(input: ManualMovementInput, { today, cycleStartedOn }: { today: string; cycleStartedOn: string | null }):
  { ok: true; value: ManualMovement } | { ok: false; error: string } {
  const direction = input.direction === "IN" || input.direction === "OUT" ? input.direction : null;
  if (!direction) return { ok: false, error: "Escolha se é uma entrada ou uma saída." };
  if (!isManualCategory(input.category) || manualCategories[input.category].direction !== direction) {
    return { ok: false, error: `Escolha uma categoria de ${direction === "IN" ? "entrada" : "saída"} da lista.` };
  }
  const raw = input.amount.trim();
  if (raw.startsWith("-")) return { ok: false, error: "Informe o valor sem sinal de menos. O tipo (entrada ou saída) já define se ele soma ou subtrai." };
  const amountCents = parseMoneyToCents(raw);
  if (amountCents === null) return { ok: false, error: "Informe o valor em reais, por exemplo 1.500,00." };
  if (amountCents <= 0) return { ok: false, error: "O valor precisa ser maior que zero." };
  if (amountCents > MAX_CENTS) return { ok: false, error: "Valor acima do limite permitido. Confira o número digitado." };
  if (!isIsoDate(input.occurredAt)) return { ok: false, error: "Informe uma data válida." };
  if (input.occurredAt > today) return { ok: false, error: "A data não pode ser depois de hoje." };
  if (cycleStartedOn && input.occurredAt < cycleStartedOn) return { ok: false, error: `A data não pode ser anterior ao início do ciclo atual da carteira (${formatDate(cycleStartedOn)}).` };
  const description = input.description.trim().replace(/\s+/g, " ");
  if (!description) return { ok: false, error: "Descreva a movimentação, por exemplo \"Salário de outubro\"." };
  if (description.length > DESCRIPTION_MAX) return { ok: false, error: `A descrição pode ter até ${DESCRIPTION_MAX} caracteres.` };
  const notes = input.notes.trim();
  if (notes.length > NOTES_MAX) return { ok: false, error: `As observações podem ter até ${NOTES_MAX} caracteres.` };
  if (!/^[A-Za-z0-9-]{16,64}$/.test(input.requestId)) return { ok: false, error: "Formulário expirado. Recarregue a página e tente de novo." };
  const category = input.category;
  return { ok: true, value: { direction, category, kind: manualCategories[category].kind, amountCents, occurredAt: input.occurredAt, description, notes: notes || null, requestId: input.requestId } };
}

// Uma saída não pode deixar o capital disponível negativo, nem hoje nem em nenhum ponto do extrato a partir da data
// escolhida (uma saída retroativa tira o valor de todos os saldos seguintes). ledger: extrato em ordem cronológica
// (o capitalLedger de buildPortfolio, do mais antigo para o mais novo); o novo lançamento entra depois dos do mesmo dia.
export function checkOutflow({ ledger, amountCents, occurredAt, availableCents }: { ledger: CapitalLedgerEntry[]; amountCents: number; occurredAt: string; availableCents: number }):
  { ok: true } | { ok: false; error: string } {
  if (amountCents > availableCents) {
    return { ok: false, error: `Saldo insuficiente: a saída de ${formatMoney(amountCents)} é maior que o capital disponível de ${formatMoney(Math.max(availableCents, 0))}. Nada foi registrado.` };
  }
  // Saldo logo depois do novo lançamento: o do último item com data até o dia escolhido. Depois, cada item posterior.
  let before = 0;
  for (const entry of ledger) if (entry.key === "initial" || entry.date <= occurredAt) before = entry.balanceCents; else break;
  const points = [{ date: occurredAt, balanceCents: before }, ...ledger.filter((entry) => entry.key !== "initial" && entry.date > occurredAt)];
  const lowest = points.reduce((low, point) => (point.balanceCents < low.balanceCents ? point : low), points[0]);
  if (lowest.balanceCents - amountCents < 0) {
    return { ok: false, error: `Com esta saída em ${formatDate(occurredAt)}, o saldo de ${formatDate(lowest.date)} ficaria negativo (${formatMoney(lowest.balanceCents)} − ${formatMoney(amountCents)}). Use uma data mais recente ou um valor menor. Nada foi registrado.` };
  }
  return { ok: true };
}

// O capital inicial abre o extrato: mudar o valor desloca todos os saldos pela diferença. Uma redução não pode deixar
// nenhum ponto do extrato (nem o capital disponível de hoje) negativo; um aumento sempre passa.
export function checkInitialCapitalChange({ ledger, previousCents, nextCents }: { ledger: CapitalLedgerEntry[]; previousCents: number; nextCents: number }):
  { ok: true } | { ok: false; error: string } {
  const reduction = previousCents - nextCents;
  if (reduction <= 0 || ledger.length === 0) return { ok: true };
  const lowest = ledger.reduce((low, entry) => (entry.balanceCents < low.balanceCents ? entry : low), ledger[0]);
  if (lowest.balanceCents - reduction < 0) {
    return { ok: false, error: `Não é possível reduzir o capital inicial em ${formatMoney(reduction)}: o saldo de ${formatDate(lowest.date)} ficaria negativo (${formatMoney(lowest.balanceCents)} − ${formatMoney(reduction)}). Registre uma saída no Financeiro se o dinheiro saiu da carteira. Nada foi alterado.` };
  }
  return { ok: true };
}

// ── Extrato financeiro ───────────────────────────────────────────────────────────────────────────────────────────────
export type FinanceRow = {
  key: string; date: string; direction: FinanceDirection; category: StatementCategory; categoryLabel: string; description: string;
  notes: string | null; amountCents: number; balanceCents: number; responsible: string; origin: string;
  // Recebimento: quanto do valor foi principal devolvido e quanto foi juros (nunca tudo como lucro).
  principalCents?: number; interestCents?: number;
};
export type FinanceFilters = { from: string; to: string; direction: FinanceDirection | null; category: StatementCategory | null };

const categoryOfEntry = (entry: CapitalLedgerEntry): StatementCategory => {
  switch (entry.kind) {
    case "INITIAL": return "INITIAL_CAPITAL";
    case "LOAN": return "LOAN";
    case "LOAN_CANCELED": return "LOAN_CANCELED";
    case "PAYMENT": return "PAYMENT";
    case "CONTRIBUTION_REVERSAL": return "CONTRIBUTION_REVERSAL";
    case "CONTRIBUTION": return "CAPITAL_CONTRIBUTION";
    case "OTHER_INCOME": return "OTHER_INCOME";
    case "WITHDRAWAL": return entry.category && isManualCategory(entry.category) ? entry.category : "LEGACY_WITHDRAWAL";
  }
};

function originOf(entry: CapitalLedgerEntry) {
  if (entry.kind === "INITIAL") return "Configurações · capital inicial";
  if (entry.kind === "LOAN") return `Operações · ${entry.operationCode ?? ""}`.trim();
  if (entry.kind === "LOAN_CANCELED") return `Operações · exclusão ${entry.operationCode ?? ""}`.trim();
  if (entry.kind === "PAYMENT") return `Pagamentos · ${entry.operationCode ?? ""}`.trim();
  if (entry.kind === "CONTRIBUTION_REVERSAL") return "Capital · estorno de aporte";
  return entry.source === "FINANCE" ? "Financeiro · lançamento manual" : "Capital · lançamento manual";
}

// Linhas do extrato (mais recentes primeiro), a partir do mesmo capitalLedger do card "Capital disponível". O saldo após
// cada linha é o do extrato completo do ciclo, então continua certo mesmo com filtros.
export function financeRows(ledger: CapitalLedgerEntry[], userNames: Map<string, string>): FinanceRow[] {
  return ledger.map((entry) => {
    const category = categoryOfEntry(entry);
    const manual = ["CONTRIBUTION", "OTHER_INCOME", "WITHDRAWAL"].includes(entry.kind);
    return {
      key: entry.key, date: entry.date, direction: entry.amountCents < 0 ? "OUT" : "IN", category, categoryLabel: statementCategoryLabels[category],
      description: entry.description, notes: entry.kind === "PAYMENT" || entry.kind === "LOAN" ? null : entry.notes ?? null,
      amountCents: Math.abs(entry.amountCents), balanceCents: entry.balanceCents,
      responsible: manual || entry.kind === "CONTRIBUTION_REVERSAL"
        ? (entry.createdByUserId ? userNames.get(entry.createdByUserId) ?? "Usuário removido" : "Não registrado (lançamento anterior ao Financeiro)")
        : "Automático (" + capitalLedgerLabels[entry.kind].toLowerCase() + ")",
      origin: originOf(entry),
      ...(entry.kind === "PAYMENT" ? { principalCents: entry.principalCents ?? 0, interestCents: entry.interestCents ?? 0 } : {}),
    };
  });
}

// Aplica período, tipo e categoria e soma o período. Entradas e saídas ficam separadas por categoria; os recebimentos
// separados em principal e juros. Saldo líquido = entradas − saídas do período (não é lucro).
export function financeStatement(rows: FinanceRow[], filters: FinanceFilters) {
  const visible = rows.filter((row) => row.date >= filters.from && row.date <= filters.to
    && (!filters.direction || row.direction === filters.direction) && (!filters.category || row.category === filters.category));
  const sum = (list: FinanceRow[]) => list.reduce((total, row) => total + row.amountCents, 0);
  const inflowsCents = sum(visible.filter((row) => row.direction === "IN"));
  const outflowsCents = sum(visible.filter((row) => row.direction === "OUT"));
  const byCategory = new Map<string, { label: string; direction: FinanceDirection; amountCents: number; count: number }>();
  const add = (key: string, label: string, direction: FinanceDirection, amountCents: number) => {
    const current = byCategory.get(key) ?? { label, direction, amountCents: 0, count: 0 };
    byCategory.set(key, { ...current, amountCents: current.amountCents + amountCents, count: current.count + 1 });
  };
  for (const row of visible) {
    if (row.category === "PAYMENT") {
      if (row.principalCents) add("PAYMENT_PRINCIPAL", "Recebimento de principal", "IN", row.principalCents);
      if (row.interestCents) add("PAYMENT_INTEREST", "Recebimento de juros", "IN", row.interestCents);
    } else add(row.category, row.categoryLabel, row.direction, row.amountCents);
  }
  return {
    rows: visible, inflowsCents, outflowsCents, netCents: inflowsCents - outflowsCents,
    categories: [...byCategory.entries()].map(([key, value]) => ({ key, ...value })).sort((a, b) => a.direction.localeCompare(b.direction) || b.amountCents - a.amountCents),
  };
}

// Períodos prontos do filtro. "Mês atual" é o padrão.
export function presetPeriods(today: string, cycleStartedOn: string | null) {
  const [year, month] = today.split("-").map(Number);
  const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  return {
    month: { label: "Mês atual", from: iso(year, month, 1), to: today },
    lastMonth: { label: "Mês anterior", from: iso(year, month - 1, 1), to: iso(year, month, 0) },
    last30: { label: "Últimos 30 dias", from: iso(year, month, Number(today.slice(8, 10)) - 29), to: today },
    cycle: { label: "Ciclo atual", from: cycleStartedOn ?? iso(year, month, 1), to: today },
  };
}

// Filtros vindos do endereço (?de=&ate=&tipo=&categoria=). Valores inválidos voltam ao padrão em vez de dar erro.
export function parseFinanceFilters(search: { de?: string; ate?: string; tipo?: string; categoria?: string }, today: string, cycleStartedOn: string | null): FinanceFilters {
  const preset = presetPeriods(today, cycleStartedOn).month;
  let from = search.de && isIsoDate(search.de) ? search.de : preset.from;
  let to = search.ate && isIsoDate(search.ate) ? search.ate : preset.to;
  if (from > to) [from, to] = [to, from];
  const direction = search.tipo === "entrada" ? "IN" : search.tipo === "saida" ? "OUT" : null;
  const category = search.categoria && isStatementCategory(search.categoria) ? search.categoria : null;
  return { from, to, direction, category };
}
