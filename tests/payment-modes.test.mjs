// Modalidades explícitas de pagamento (03/11/2026): "Só os juros e renovar", manual, amortização, saldo total e
// liquidação antecipada; juros dos períodos seguintes sem juros sobre juros; preservação dos contratos antigos.
// Os números de cada teste estão na seção 9 do pedido (testes obrigatórios).
import { test } from "node:test";
import assert from "node:assert/strict";
import { operationLedger, paymentLabel, planPayment } from "../src/lib/finance/rules.ts";
import * as antes from "./helpers/rules-antes-0054.ts";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { managerCommission } from "../src/lib/managers/commission.ts";
import { profitabilityReport } from "../src/lib/finance/report.ts";

// R$ 5.000 a 2% ao mês (R$ 100 por período), pagamento único mensal, 1º vencimento 01/05/2023 (caso Tatiana).
const contract = (paymentOrder, extra = {}) => ({
  modality: "SINGLE", frequency: "MONTHLY", principalCents: 500000, interestRateBps: 200, interestCents: 10000, firstDueDate: "2023-05-01",
  installmentCount: null, installmentCents: null, renewals: [], paymentOrder, ...extra,
});

// Grava (em memória) pagamentos pela mesma função do servidor: planPayment valida e devolve a renovação a gravar.
function record(terms, steps, asOfFn = (paidAt) => paidAt) {
  let current = { ...terms, renewals: [...terms.renewals] };
  const payments = [];
  for (const [id, mode, amountCents, paidAt, extra = {}] of steps) {
    const plan = planPayment(current, payments, { mode, amountCents, paidAt, ...extra }, asOfFn(paidAt), id);
    assert.equal(plan.ok, true, `${id}: ${plan.error}`);
    payments.push({ id, amountCents, paidAt, createdAt: `${paidAt}T12:00:${String(payments.length).padStart(2, "0")}Z`, mode: plan.mode, allocationOrder: plan.allocationOrder });
    if (plan.renewal) current = { ...current, renewals: [...current.renewals, { paymentId: id, ...plan.renewal }] };
  }
  return { terms: current, payments };
}
const monthly = (n) => Array.from({ length: n }, (_, k) => `2023-${String(5 + k).padStart(2, "0")}-01`);

test("MP1. principal primeiro + 'Só os juros e renovar': 100% juros, principal intacto, renova e o próximo período cobra sobre o principal", () => {
  const plan = planPayment(contract("PRINCIPAL_FIRST"), [], { mode: "INTEREST_ONLY_RENEWAL", amountCents: 10000, paidAt: "2023-05-01", expectedPeriod: 1 }, "2023-05-01");
  assert.equal(plan.ok, true);
  assert.equal(plan.interestCents, 10000);
  assert.equal(plan.principalCents, 0);
  assert.equal(plan.principalBeforeCents, 500000);
  assert.equal(plan.principalAfterCents, 500000);
  assert.deepEqual(plan.renewal, { periodNumber: 2, previousDueDate: "2023-05-01", newDueDate: "2023-06-01", principalBaseCents: 500000, interestCents: 10000 });
  assert.equal(plan.nextDueDate, "2023-06-01");
  assert.equal(plan.nextInterestCents, 10000);
  assert.equal(plan.after.balanceCents, 510000);
  assert.equal(paymentLabel(plan.item), "Juros / Renovação");
});

test("MP2. juros primeiro + 'Só os juros e renovar': mesmo resultado", () => {
  const plan = planPayment(contract("INTEREST_FIRST"), [], { mode: "INTEREST_ONLY_RENEWAL", amountCents: 10000, paidAt: "2023-04-20", expectedPeriod: 1 }, "2023-04-20");
  assert.equal(plan.ok, true);
  assert.equal(plan.interestCents, 10000);
  assert.equal(plan.principalCents, 0);
  assert.equal(plan.renewal.newDueDate, "2023-06-01");
  assert.equal(plan.after.principalRemainingCents, 500000);
});

test("MP3. oito 'Só os juros' seguidos (caso Tatiana corrigido): juros R$ 800, principal R$ 0 recebido, R$ 5.000 em aberto, 8 renovações, vencimento 01/01/2024", () => {
  const { terms, payments } = record(contract("PRINCIPAL_FIRST"), monthly(8).map((date, k) => [`t${k + 1}`, "INTEREST_ONLY_RENEWAL", 10000, date, { expectedPeriod: k + 1 }]));
  const ledger = operationLedger(terms, payments, "2023-12-01");
  assert.equal(ledger.interestPaidCents, 80000);
  assert.equal(ledger.principalPaidCents, 0);
  assert.equal(ledger.principalRemainingCents, 500000);
  assert.equal(ledger.renewalCount, 8);
  assert.equal(ledger.nextDueDate, "2024-01-01");
  assert.equal(ledger.balanceCents, 510000);
  assert.ok(ledger.items.every((item) => item.kind === "RENEWAL" && item.principalCents === 0));
  // Hoje: o 9º período (01/01/2024) está vencido e sem pagar; pela sequência (14/11/2026), nenhum período novo nasce até
  // ele ser pago. Saldo = principal + os juros vencidos e exigíveis (só os do 9º).
  const hoje = operationLedger(terms, payments, "2026-11-03");
  assert.equal(hoje.principalRemainingCents, 500000);
  assert.equal(hoje.nextDueDate, "2024-01-01");
  assert.equal(hoje.state, "OVERDUE");
  assert.equal(hoje.pendingPeriods.length, 1);
  assert.equal(hoje.interestRemainingCents, 10000);
  assert.equal(hoje.balanceCents, 510000);
  assert.equal(hoje.renewalCount, 8, "períodos abertos em atraso não contam como renovação");
});

test("MP4. renovação sem duplicidade: o mesmo período não renova duas vezes; valor diferente e pagamento retroativo recusados", () => {
  const { terms, payments } = record(contract("PRINCIPAL_FIRST"), [["r1", "INTEREST_ONLY_RENEWAL", 10000, "2023-05-01", { expectedPeriod: 1 }]]);
  const again = planPayment(terms, payments, { mode: "INTEREST_ONLY_RENEWAL", amountCents: 10000, paidAt: "2023-05-01", expectedPeriod: 1 }, "2023-05-01");
  assert.equal(again.ok, false);
  assert.match(again.error, /já foi renovado/);
  assert.match(planPayment(terms, payments, { mode: "INTEREST_ONLY_RENEWAL", amountCents: 9000, paidAt: "2023-05-02" }, "2023-05-02").error, /exatamente os juros pendentes/);
  assert.match(planPayment(terms, payments, { mode: "INTEREST_ONLY_RENEWAL", amountCents: 10000, paidAt: "2023-04-30" }, "2023-05-02").error, /mais recente/);
  assert.match(planPayment(contract("PRINCIPAL_FIRST"), [], { mode: "INTEREST_ONLY_RENEWAL", amountCents: 20000, paidAt: "2023-05-01" }, "2023-05-01").error, /exatamente/, "não aceita mais que o devido");
  // Sem principal em aberto não há o que renovar; parcelado não renova.
  const paidPrincipal = record(contract("PRINCIPAL_FIRST"), [["a", "PRINCIPAL_AMORTIZATION", 500000, "2023-04-10"]]);
  assert.match(planPayment(paidPrincipal.terms, paidPrincipal.payments, { mode: "INTEREST_ONLY_RENEWAL", amountCents: 10000, paidAt: "2023-04-11" }, "2023-04-11").error, /principal em aberto/);
  const parcelado = { ...contract("PRINCIPAL_FIRST"), modality: "INSTALLMENT", interestCents: 100000, installmentCount: 10, installmentCents: 60000 };
  assert.equal(planPayment(parcelado, [], { mode: "INTEREST_ONLY_RENEWAL", amountCents: 60000, paidAt: "2023-05-01" }, "2023-05-01").ok, false);
});

test("MP5. com juros vencidos sem pagar, o período seguinte não nasce: R$ 5.000 a 2% atrasado 3 meses = R$ 5.100", () => {
  const ledger = operationLedger(contract("PRINCIPAL_FIRST"), [], "2023-07-01");
  assert.equal(ledger.principalRemainingCents, 500000);
  assert.deepEqual(ledger.pendingPeriods.map((item) => [item.number, item.dueDate, item.remainingCents]), [[1, "2023-05-01", 10000]]);
  assert.equal(ledger.interestRemainingCents, 10000);
  assert.equal(ledger.balanceCents, 510000);
  assert.equal(ledger.nextDueDate, "2023-05-01", "cobra a partir do período pendente mais antigo");
  assert.equal(operationLedger(contract("PRINCIPAL_FIRST"), [], "2023-05-01").interestRemainingCents, 10000, "no dia do vencimento ainda não está atrasado");
  assert.equal(operationLedger(contract("PRINCIPAL_FIRST"), [], "2023-05-02").interestRemainingCents, 10000);
  // Recebe o 1º período (atrasado): renova pelo calendário do contrato (o 2º vence 01/06) e o 2º passa a ser exigível.
  const summed = planPayment(contract("PRINCIPAL_FIRST"), [], { mode: "INTEREST_ONLY_RENEWAL", amountCents: 30000, paidAt: "2023-07-01", expectedPeriod: 1 }, "2023-07-01");
  assert.equal(summed.ok, false);
  assert.equal(planPayment(contract("PRINCIPAL_FIRST"), [], { mode: "INTEREST_ONLY_RENEWAL", amountCents: 10000, paidAt: "2023-07-01", period: 3 }, "2023-07-01").ok, false, "o 3º período não existe");
  const plan = planPayment(contract("PRINCIPAL_FIRST"), [], { mode: "INTEREST_ONLY_RENEWAL", amountCents: 10000, paidAt: "2023-07-01", period: 1 }, "2023-07-01");
  assert.equal(plan.ok, true);
  assert.equal(plan.renewal.previousDueDate, "2023-05-01");
  assert.equal(plan.renewal.newDueDate, "2023-06-01");
  assert.equal(plan.after.interestRemainingCents, 10000, "só o 2º período (já vencido) fica pendente");
  assert.equal(plan.principalAfterCents, 500000);
});

test("MP6. sem capitalização: cada período cobra juros só sobre o principal em aberto, nunca sobre juros pendentes", () => {
  const ledger = operationLedger(contract("PRINCIPAL_FIRST"), [], "2024-05-02");
  assert.equal(ledger.periods.length, 1, "sem pagar, não nascem períodos novos");
  assert.equal(ledger.interestRemainingCents, 10000);
  // Amortização de R$ 2.500 em 15/06 reduz à metade os juros do período aberto depois dela; o já aberto não muda.
  const { terms, payments } = record(contract("PRINCIPAL_FIRST"), [["a", "PRINCIPAL_AMORTIZATION", 250000, "2023-06-15"], ["j", "INTEREST_ONLY_RENEWAL", 10000, "2023-06-16", { period: 1 }]]);
  const after = operationLedger(terms, payments, "2023-06-16");
  assert.deepEqual(after.periods.map((period) => period.interestCents), [10000, 5000]);
  assert.equal(after.interestRemainingCents, 5000);
});

test("MP7. pagamento manual respeita a ordem do contrato (principal primeiro × juros primeiro) e não renova", () => {
  const pf = planPayment(contract("PRINCIPAL_FIRST"), [], { mode: "MANUAL", amountCents: 10000, paidAt: "2023-05-01" }, "2023-05-01");
  assert.equal(pf.principalCents, 10000);
  assert.equal(pf.interestCents, 0);
  assert.equal(pf.renewal, null);
  assert.equal(pf.allocationOrder, "PRINCIPAL_FIRST");
  const pf2 = planPayment(contract("PRINCIPAL_FIRST"), [], { mode: "MANUAL", amountCents: 505000, paidAt: "2023-05-01" }, "2023-05-01");
  assert.deepEqual([pf2.principalCents, pf2.interestCents, pf2.after.balanceCents], [500000, 5000, 5000]);
  const iff = planPayment(contract("INTEREST_FIRST"), [], { mode: "MANUAL", amountCents: 60000, paidAt: "2023-05-01" }, "2023-05-01");
  assert.deepEqual([iff.interestCents, iff.principalCents], [10000, 50000]);
  assert.equal(iff.allocationOrder, "INTEREST_FIRST");
  assert.match(planPayment(contract("INTEREST_FIRST"), [], { mode: "MANUAL", amountCents: 510001, paidAt: "2023-05-01" }, "2023-05-01").error, /maior que o saldo/);
});

test("MP8. amortização do principal: só principal (também no juros primeiro), juros pendentes continuam; acima do principal recusado", () => {
  const plan = planPayment(contract("INTEREST_FIRST"), [], { mode: "PRINCIPAL_AMORTIZATION", amountCents: 100000, paidAt: "2023-04-20" }, "2023-04-20");
  assert.deepEqual([plan.principalCents, plan.interestCents], [100000, 0]);
  assert.equal(plan.after.interestRemainingCents, 10000);
  assert.equal(plan.after.principalRemainingCents, 400000);
  assert.equal(paymentLabel(plan.item), "Amortização do principal");
  assert.match(planPayment(contract("INTEREST_FIRST"), [], { mode: "PRINCIPAL_AMORTIZATION", amountCents: 500001, paidAt: "2023-04-20" }, "2023-04-20").error, /principal em aberto/);
});

test("MP9. saldo total: exatamente principal + juros pendentes; quita; outro valor recusado", () => {
  const late = planPayment(contract("PRINCIPAL_FIRST"), [], { mode: "FULL_SETTLEMENT", amountCents: 510000, paidAt: "2023-07-01" }, "2023-07-01");
  assert.equal(late.ok, true);
  assert.equal(late.settles, true);
  assert.deepEqual([late.principalCents, late.interestCents], [500000, 10000]);
  assert.equal(paymentLabel(late.item), "Quitação");
  assert.match(planPayment(contract("PRINCIPAL_FIRST"), [], { mode: "FULL_SETTLEMENT", amountCents: 530000, paidAt: "2023-07-01" }, "2023-07-01").error, /saldo total nesta data é/, "juros de períodos futuros não entram");
});

test("MP10. liquidação antecipada: só pelo formulário próprio; principal primeiro, o resto juros, o que faltava é desconto", () => {
  assert.match(planPayment(contract("INTEREST_FIRST"), [], { mode: "EARLY_SETTLEMENT", amountCents: 500000, paidAt: "2023-04-20" }, "2023-04-20").error, /formulário próprio/);
  const terms = { ...contract("PRINCIPAL_FIRST"), settlementPaymentId: "liq" };
  const ledger = operationLedger(terms, [{ id: "liq", amountCents: 505000, paidAt: "2023-07-01", mode: "EARLY_SETTLEMENT", allocationOrder: "PRINCIPAL_FIRST" }], "2023-07-01");
  assert.deepEqual([ledger.principalPaidCents, ledger.interestPaidCents, ledger.forgivenCents, ledger.balanceCents], [500000, 5000, 5000, 0]);
  assert.equal(paymentLabel(ledger.items[0]), "Liquidação antecipada");
});

test("MP11. prévia = gravado: o extrato recalculado a partir do que o servidor grava bate com a prévia em todos os modos", () => {
  const cases = [
    [contract("PRINCIPAL_FIRST"), "INTEREST_ONLY_RENEWAL", 10000, "2023-07-01", { period: 1 }],
    [contract("INTEREST_FIRST"), "INTEREST_ONLY_RENEWAL", 10000, "2023-04-20", { expectedPeriod: 1 }],
    [contract("PRINCIPAL_FIRST"), "MANUAL", 123456, "2023-06-10", {}],
    [contract("INTEREST_FIRST"), "MANUAL", 123456, "2023-06-10", {}],
    [contract("INTEREST_FIRST"), "PRINCIPAL_AMORTIZATION", 50000, "2023-04-10", {}],
    [contract("PRINCIPAL_FIRST"), "FULL_SETTLEMENT", 510000, "2023-06-10", {}],
  ];
  for (const [terms, mode, amountCents, paidAt, extra] of cases) {
    const preview = planPayment(terms, [], { mode, amountCents, paidAt, ...extra }, "2023-08-20", "preview");
    assert.equal(preview.ok, true, `${mode}: ${preview.error}`);
    // O que o servidor grava: o pagamento (com modalidade e ordem) e, se renovou, a linha de loan_renewal.
    const saved = { id: "pay_x", amountCents, paidAt, createdAt: "2026-11-03T12:00:00Z", mode: preview.mode, allocationOrder: preview.allocationOrder, period: preview.period };
    const savedTerms = preview.renewal ? { ...terms, renewals: [{ paymentId: "pay_x", ...preview.renewal }] } : terms;
    const reread = operationLedger(savedTerms, [saved], "2023-08-20");
    const item = reread.items[0];
    assert.deepEqual([item.interestCents, item.principalCents, item.kind], [preview.item.interestCents, preview.item.principalCents, preview.item.kind], mode);
    assert.deepEqual([reread.balanceCents, reread.nextDueDate, reread.interestPaidCents, reread.principalPaidCents], [preview.after.balanceCents, preview.after.nextDueDate, preview.after.interestPaidCents, preview.after.principalPaidCents], mode);
  }
});

test("MP12. consistência: histórico, cards, extrato de caixa, relatório e comissão usam a mesma divisão", () => {
  const { terms, payments } = record(contract("PRINCIPAL_FIRST", { firstDueDate: "2026-09-01" }), [
    ["j1", "INTEREST_ONLY_RENEWAL", 10000, "2026-09-01", { expectedPeriod: 1 }],
    ["m2", "MANUAL", 20000, "2026-09-15"],
    ["j3", "INTEREST_ONLY_RENEWAL", 10000, "2026-10-01", { expectedPeriod: 2 }],
  ], () => "2026-11-03");
  const operation = {
    id: "op_x", clientId: "c_x", clientName: "Cliente X", principalCents: 500000, interestRateBps: 200, interestCents: 10000, totalCents: 510000,
    loanDate: "2026-08-01", dueDate: "2026-11-01", status: "OPEN", settledAt: null, calculationRule: "RATE_PER_OPERATION_SINGLE_PAYMENT_V1", createdAt: "2026-08-01T00:00:00Z",
    firstDueDate: "2026-09-01", paymentOrder: "PRINCIPAL_FIRST", modality: "SINGLE", frequency: "MONTHLY",
    renewals: terms.renewals.map((row, index) => ({ id: `ren_${index}`, createdAt: "2026-11-03T00:00:00Z", ...row })),
  };
  const portfolio = buildPortfolio({ initialCapitalCents: 1000000, hasWallet: true, operations: [operation], payments: payments.map((payment) => ({ ...payment, operationId: "op_x", clientName: "Cliente X", notes: null })), today: "2026-11-03" });
  const ledger = operationLedger(terms, payments, "2026-11-03");
  const view = portfolio.operations[0];
  assert.equal(view.interestPaidCents, ledger.interestPaidCents);
  assert.equal(view.principalPaidCents, ledger.principalPaidCents);
  assert.deepEqual(view.payments.map((item) => [item.id, item.interestCents, item.principalCents]).reverse(), ledger.items.map((item) => [item.id, item.interestCents, item.principalCents]));
  assert.deepEqual(view.payments.map(paymentLabel).reverse(), ["Juros / Renovação", "Amortização do principal", "Juros / Renovação"]);
  assert.equal(portfolio.summary.receivedInterestCents, 20000);
  assert.equal(portfolio.summary.receivedPrincipalCents, 20000);
  const cash = portfolio.capitalLedger.filter((entry) => entry.kind === "PAYMENT");
  assert.equal(cash.reduce((total, entry) => total + entry.interestCents, 0), 20000);
  assert.equal(cash.reduce((total, entry) => total + entry.principalCents, 0), 20000);
  assert.equal(managerCommission([{ bps: 1000, operations: [view] }], 0).interestReceivedCents, 20000);
  const report = profitabilityReport(portfolio.operations, { period: "CYCLE", scope: "CYCLE", status: "ALL" }, "2026-11-03");
  assert.equal(report.totals.interestReceivedCents, 20000);
  assert.equal(report.totals.principalReceivedCents, 20000);
});

test("MP13. contratos antigos preservados: pagamentos sem modalidade dão exatamente o mesmo extrato da versão publicada", () => {
  // Gerador determinístico de cenários: contratos de juros primeiro (antigos) e de principal primeiro sem períodos vencidos.
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const fields = ["interestPaidCents", "principalPaidCents", "interestRemainingCents", "principalRemainingCents", "balanceCents", "nextDueDate", "renewalCount", "state", "interestCents"];
  for (let run = 0; run < 400; run += 1) {
    const order = run % 4 === 0 ? undefined : "INTEREST_FIRST";
    const base = contract(order, { firstDueDate: "2026-01-10", frequency: run % 3 === 0 ? "BIWEEKLY" : "MONTHLY" });
    const payments = [], renewals = [];
    let date = "2025-12-20";
    for (let k = 0; k < 1 + rnd(6); k += 1) {
      const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 3 + rnd(40)); date = d.toISOString().slice(0, 10);
      const before = antes.operationLedger({ ...base, renewals }, payments, date);
      if (before.balanceCents <= 0) break;
      const kind = rnd(3);
      const amount = kind === 0 ? before.interestRemainingCents || 5000 : Math.min(before.balanceCents, 1000 + rnd(200000));
      const renewal = kind === 0 ? antes.interestOnlyRenewal({ ...base, renewals }, before, amount) : null;
      const id = `p${k}`;
      payments.push({ id, amountCents: amount, paidAt: date, createdAt: `${date}T12:00:00Z` });
      if (renewal) renewals.push({ paymentId: id, periodNumber: before.periodNumber + 1, previousDueDate: renewal.previousDueDate, newDueDate: renewal.defaultNewDueDate, principalBaseCents: renewal.principalBaseCents, interestCents: renewal.nextInterestCents });
    }
    const terms = { ...base, renewals };
    for (const asOf of [date, "2026-11-03"]) {
      const old = antes.operationLedger(terms, payments, asOf), now = operationLedger(terms, payments, asOf);
      for (const field of fields) assert.deepEqual(now[field], old[field], `cenário ${run}, ${field} em ${asOf}`);
      assert.deepEqual(now.items.map((item) => [item.interestCents, item.principalCents, item.kind]), old.items.map((item) => [item.interestCents, item.principalCents, item.kind]), `cenário ${run}`);
    }
  }
});

test("MP14. sem reclassificação: a ordem gravada no pagamento manual vale mesmo se a regra do contrato mudar; edição não troca modalidade", () => {
  const { terms, payments } = record(contract("PRINCIPAL_FIRST"), [["m1", "MANUAL", 10000, "2023-04-20"], ["j2", "INTEREST_ONLY_RENEWAL", 10000, "2023-04-21", { expectedPeriod: 1 }]]);
  const changed = { ...terms, paymentOrder: "INTEREST_FIRST" };
  const ledger = operationLedger(changed, payments, "2023-04-21");
  assert.deepEqual(ledger.items.map((item) => [item.id, item.interestCents, item.principalCents]), [["m1", 0, 10000], ["j2", 10000, 0]]);
  // Pagamento antigo (sem modalidade) continua pela regra de antes: segue o contrato.
  const legacy = operationLedger(contract("PRINCIPAL_FIRST"), [{ id: "x", amountCents: 10000, paidAt: "2023-05-01" }], "2023-05-01");
  assert.deepEqual([legacy.items[0].principalCents, legacy.items[0].interestCents], [10000, 0]);
});
