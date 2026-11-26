import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { renegotiationContract, renegotiationPosition, simulateRenegotiation } from "../src/lib/finance/renegotiation.ts";
import { amortizedSchedule } from "../src/lib/finance/rules.ts";
import { profitabilityReport } from "../src/lib/finance/report.ts";

// Renegociação com o valor da parcela negociado com o cliente (sem obrigar o cálculo pela taxa).
const TODAY = "2026-11-26";
// Caso do pedido: principal em aberto R$ 3.000, juros em aberto R$ 2.250, saldo R$ 5.250; novo acordo 10 × R$ 700.
const priscila = { id: "op_p", clientId: "c1", clientName: "Cliente", principalCents: 300_000, interestRateBps: 1500, interestCents: 225_000, totalCents: 525_000,
  loanDate: "2026-08-18", dueDate: "2026-09-18", firstDueDate: "2026-09-18", status: "OPEN", settledAt: null, calculationRule: "RATE_PER_OPERATION_SINGLE_PAYMENT_V1", createdAt: "2026-08-18T10:00:00Z" };
const build = (operations, payments = []) => buildPortfolio({ initialCapitalCents: 1_000_000, hasWallet: true, operations, payments, today: TODAY });
const manualTerms = { modality: "INSTALLMENT", frequency: "MONTHLY", rateBps: 0, count: 10, firstDueDate: "2026-12-26", adjustmentCents: 0, installmentCents: 70_000 };

test("RM1. valor manual: 10 × R$ 700 = R$ 7.000, parcelas exatamente iguais, sem arredondamento", () => {
  const position = renegotiationPosition(build([priscila]).operations);
  assert.equal(position.balanceCents, 525_000);
  const sim = simulateRenegotiation(position, manualTerms);
  assert.equal(sim.manual, true);
  assert.equal(sim.totalCents, 700_000);
  assert.ok(sim.payments.every((payment) => payment.amountCents === 70_000));
  assert.equal(sim.payments.reduce((sum, payment) => sum + payment.amountCents, 0), 700_000);
  assert.equal(sim.newInterestCents, 175_000, "o que passa do saldo atual vira juros novos");
  assert.equal(sim.payments[9].dueDate, "2027-09-26");
  const built = renegotiationContract(position, manualTerms, TODAY);
  assert.ok(built.ok);
  const { contract } = built;
  assert.equal(built.roundingCents, 0);
  assert.equal(contract.installmentCents, 70_000);
  assert.equal(contract.totalCents, 700_000);
  assert.equal(contract.principalCents, 300_000, "principal = só o principal em aberto, sem duplicar");
  assert.equal(contract.interestCents, 400_000);
  assert.equal(contract.interestRateBps, 1333.3, "taxa simples equivalente: 4.000 ÷ 3.000 ÷ 10");
  assert.equal(contract.dueDate, "2027-09-26");
  const schedule = amortizedSchedule({ ...contract, paidCents: 0 }, 0);
  assert.deepEqual(schedule.map((item) => item.amountCents), Array(10).fill(70_000));
  assert.deepEqual(schedule.map((item) => item.dueDate), sim.payments.map((payment) => payment.dueDate), "cronograma gravado = prévia");
});

test("RM2. cálculo automático continua igual quando a parcela não é informada (taxa manda)", () => {
  const position = renegotiationPosition(build([priscila]).operations);
  const auto = { ...manualTerms, rateBps: 500, installmentCents: null };
  const sim = simulateRenegotiation(position, auto);
  assert.equal(sim.manual, false);
  assert.equal(sim.newInterestCents, 150_000, "5% × 3.000 × 10");
  assert.equal(sim.totalCents, 675_000);
  const built = renegotiationContract(position, auto, TODAY);
  assert.ok(built.ok);
  assert.equal(built.contract.installmentCents, 67_500);
  assert.equal(built.contract.interestRateBps, 500);
  // Pagamento único ignora a parcela informada.
  const single = simulateRenegotiation(position, { ...auto, modality: "SINGLE", installmentCents: 70_000 });
  assert.equal(single.manual, false);
});

test("RM3. valor abaixo do saldo é desconto nos juros; abaixo do principal é recusado; parcela inválida é recusada", () => {
  const position = renegotiationPosition(build([priscila]).operations);
  const low = renegotiationContract(position, { ...manualTerms, installmentCents: 50_000 }, TODAY);
  assert.ok(low.ok);
  assert.equal(low.sim.adjustmentCents, -25_000, "R$ 5.000 contra saldo R$ 5.250: desconto de R$ 250 nos juros");
  assert.equal(low.sim.newInterestCents, 0);
  assert.equal(low.contract.totalCents, 500_000);
  assert.equal(low.contract.principalCents, 300_000);
  const tooLow = renegotiationContract(position, { ...manualTerms, installmentCents: 29_999 }, TODAY);
  assert.equal(tooLow.ok, false);
  assert.match(tooLow.error, /principal em aberto/);
  assert.equal(renegotiationContract(position, { ...manualTerms, installmentCents: 0 }, TODAY).ok, false);
});

test("RM4. multa no valor manual: só a última parcela leva a multa; total = parcela × n + multa", () => {
  const position = renegotiationPosition(build([priscila]).operations);
  const built = renegotiationContract(position, { ...manualTerms, penaltyCents: 10_000 }, TODAY);
  assert.ok(built.ok);
  assert.equal(built.contract.totalCents, 710_000);
  const schedule = amortizedSchedule({ ...built.contract, paidCents: 0 }, 0);
  assert.equal(schedule[0].amountCents, 70_000);
  assert.equal(schedule[9].amountCents, 80_000);
  assert.deepEqual(built.sim.payments.map((payment) => payment.amountCents), schedule.map((item) => item.amountCents));
});

test("RM5. gravado: antiga Renegociada com vínculo, capital intacto, saldo = contrato novo e relatório sem principal em dobro", () => {
  const before = build([priscila]);
  const position = renegotiationPosition(before.operations);
  const built = renegotiationContract(position, manualTerms, TODAY);
  assert.ok(built.ok);
  const operations = [
    { ...priscila, status: "RENEGOTIATED", renegotiatedIntoId: "op_n", renegotiatedOn: TODAY, renegotiatedAt: "2026-11-26T10:00:00.000Z", renegotiatedPrincipalCents: 300_000, renegotiatedInterestCents: 225_000, settledAt: TODAY },
    { ...priscila, id: "op_n", loanDate: TODAY, createdAt: "2026-11-26T10:00:00.001Z", ...built.contract, status: "OPEN" },
  ];
  const after = build(operations);
  assert.equal(after.summary.availableCents, before.summary.availableCents);
  assert.equal(after.summary.lentCents, before.summary.lentCents);
  const oldView = after.operations.find((operation) => operation.id === "op_p");
  const newView = after.operations.find((operation) => operation.id === "op_n");
  assert.equal(oldView.state, "RENEGOTIATED");
  assert.equal(oldView.balanceCents, 0);
  assert.equal(oldView.renegotiatedIntoCode, newView.code);
  assert.equal(newView.balanceCents, 700_000);
  assert.equal(after.summary.receivableCents, 700_000);
  const report = profitabilityReport(after.operations, { period: "CYCLE", from: "", to: "", status: "ALL" }, TODAY);
  assert.equal(report.totals.principalLentCents, 300_000);
});
