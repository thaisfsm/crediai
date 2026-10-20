import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { receivablesOverview } from "../src/lib/finance/receivables.ts";

// Contas a receber do Dashboard: atrasado, a receber hoje, próximos 7 dias, recebido hoje e total. Dados fictícios.
const TODAY = "2026-10-13";
const base = (id, extra) => ({
  id, clientId: `c_${id}`, clientName: `Cliente ${id}`, principalCents: 100000, interestRateBps: 1000, interestCents: 10000, totalCents: 110000,
  loanDate: "2026-08-01", status: "OPEN", settledAt: null, calculationRule: "RATE_PER_OPERATION_SINGLE_PAYMENT_V1", createdAt: "2026-08-01T10:00:00Z", ...extra,
});
const single = (id, due, extra = {}) => base(id, { dueDate: due, firstDueDate: due, ...extra });
const installment = (id, firstDue, count, extra = {}) => base(id, {
  modality: "INSTALLMENT", installmentCount: count, installmentCents: 100000, principalCents: count * 90000, interestCents: count * 10000, totalCents: count * 100000,
  firstDueDate: firstDue, dueDate: firstDue, calculationRule: "FIXED_MONTHLY_INSTALLMENTS_V1", ...extra,
});
let seq = 0;
const pay = (operationId, amountCents, paidAt) => ({ id: `p${++seq}`, operationId, clientName: "x", amountCents, paidAt, notes: null, createdAt: `${paidAt}T12:00:${String(seq % 60).padStart(2, "0")}Z` });
const overviewOf = (operations, payments = []) => {
  const portfolio = buildPortfolio({ initialCapitalCents: 10_000_000, hasWallet: true, operations, payments, today: TODAY });
  return { portfolio, overview: receivablesOverview(portfolio.operations, TODAY, portfolio.summary.receivableCents) };
};

test("R1. atrasado, hoje e próximos 7 dias ficam separados e somam o saldo de cada operação", () => {
  const { overview } = overviewOf([single("antiga", "2026-09-01"), single("hoje", TODAY), single("d5", "2026-10-18"), single("d30", "2026-11-12")]);
  assert.equal(overview.overdueCount, 1);
  assert.equal(overview.overdueCents, 110000);
  assert.equal(overview.dueTodayCount, 1);
  assert.equal(overview.dueTodayCents, 110000);
  assert.equal(overview.upcomingCount, 1, "só a que vence em até 7 dias");
  assert.equal(overview.upcomingCents, 110000);
  assert.equal(overview.upcomingUntil, "2026-10-20");
});

test("R2. total a receber é o mesmo saldo em aberto do card Total a receber", () => {
  const { overview, portfolio } = overviewOf([single("a", "2026-09-01"), single("b", "2026-11-12")]);
  assert.equal(overview.totalCents, portfolio.summary.receivableCents);
  assert.equal(overview.totalCents, 220000);
  assert.equal(overview.openCount, 2);
});

test("R3. parcelado: várias parcelas atrasadas somam; a de hoje e a futura ficam nos seus grupos", () => {
  // Parcelas de R$ 1.000 em 13/08, 13/09, 13/10 (hoje), 13/11: duas atrasadas, uma hoje, uma futura (fora dos 7 dias).
  const { overview } = overviewOf([installment("p", "2026-08-13", 4)]);
  assert.equal(overview.overdueCents, 200000);
  assert.equal(overview.overdueCount, 1, "uma operação");
  assert.equal(overview.overdueList[0].detail, "Op. #" + overview.overdueList[0].code + " · Parcela 1/4 e Parcela 2/4");
  assert.equal(overview.dueTodayCents, 100000);
  assert.equal(overview.upcomingCents, 0);
});

test("R4. pagamento parcial: só o que falta entra; pagamento total tira do atraso; recebido hoje soma o dia", () => {
  const partial = overviewOf([installment("p", "2026-09-13", 3)], [pay("p", 40000, "2026-09-20")]);
  assert.equal(partial.overview.overdueCents, 60000, "R$ 1.000 menos R$ 400 pagos");
  const paid = overviewOf([installment("p", "2026-09-13", 3)], [pay("p", 100000, "2026-09-13"), pay("p", 100000, TODAY)]);
  assert.equal(paid.overview.overdueCents, 0);
  assert.equal(paid.overview.dueTodayCents, 0, "a de hoje foi paga");
  assert.equal(paid.overview.receivedTodayCents, 100000);
  assert.equal(paid.overview.receivedTodayCount, 1);
});

test("R5. operação quitada ou cancelada não entra; carteira vazia dá zeros", () => {
  const { overview } = overviewOf([single("q", "2026-09-01", { status: "PAID", settledAt: "2026-09-02" }), single("c", "2026-09-01", { status: "CANCELED" })]);
  assert.equal(overview.overdueCents + overview.dueTodayCents + overview.upcomingCents + overview.totalCents, 0);
  const empty = overviewOf([]).overview;
  assert.deepEqual([empty.overdueCount, empty.dueTodayCount, empty.openCount, empty.overdueList.length], [0, 0, 0, 0]);
});

test("R6. listas: mais antigas primeiro, no máximo 5, com a contagem completa", () => {
  const ops = Array.from({ length: 7 }, (_, index) => single(`o${index}`, `2026-09-${String(10 + index).padStart(2, "0")}`));
  const { overview } = overviewOf(ops);
  assert.equal(overview.overdueCount, 7);
  assert.equal(overview.overdueList.length, 5);
  assert.deepEqual(overview.overdueList.map((row) => row.dueDate), ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"]);
  assert.equal(overview.overdueCents, 7 * 110000);
});
