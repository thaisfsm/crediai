import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { renegotiationContract, renegotiationPosition } from "../src/lib/finance/renegotiation.ts";
import { amortizedSchedule } from "../src/lib/finance/rules.ts";
import { profitabilityReport } from "../src/lib/finance/report.ts";

// Gravação da renegociação: contrato derivado, capital líquido zero, vínculo e relatório sem contar o principal duas vezes.
const TODAY = "2026-10-17";
const old = (id, principalCents, status = "OPEN", extra = {}) => ({
  id, clientId: "c1", clientName: "Cliente", principalCents, interestRateBps: 1000, interestCents: principalCents / 10, totalCents: principalCents * 1.1,
  loanDate: "2026-09-01", dueDate: "2026-10-01", firstDueDate: "2026-10-01", status, settledAt: null, calculationRule: "RATE_PER_OPERATION_SINGLE_PAYMENT_V1",
  createdAt: "2026-09-01T10:00:00Z", ...extra,
});
const build = (operations, payments = []) => buildPortfolio({ initialCapitalCents: 1_000_000, hasWallet: true, operations, payments, today: TODAY });
const pay = (operationId, amountCents) => ({ id: `p-${operationId}`, operationId, clientName: "Cliente", amountCents, paidAt: "2026-09-20", notes: null, createdAt: "2026-09-20T12:00:00Z" });

test("RS1. contrato parcelado: principal = principal em aberto, parcela arredondada para cima, diferença nos juros", () => {
  const position = renegotiationPosition(build([old("op_a", 100_000), old("op_b", 50_000)], [pay("op_a", 10_000)]).operations);
  assert.equal(position.principalOpenCents, 150_000);
  const built = renegotiationContract(position, { modality: "INSTALLMENT", frequency: "MONTHLY", rateBps: 500, count: 3, firstDueDate: "2026-11-10", adjustmentCents: 0 }, TODAY);
  assert.ok(built.ok);
  const { contract } = built;
  assert.equal(contract.principalCents, 150_000);
  assert.equal(contract.installmentCents * 3, contract.totalCents);
  assert.equal(contract.totalCents, contract.principalCents + contract.interestCents);
  assert.ok(contract.totalCents >= built.sim.totalCents && contract.totalCents - built.sim.totalCents === built.roundingCents && built.roundingCents < 3);
  assert.equal(contract.dueDate, "2027-01-10");
});

test("RS2. desconto maior que os juros em aberto e vencimento no passado são recusados", () => {
  const position = renegotiationPosition(build([old("op_a", 100_000)]).operations);
  const base = { modality: "SINGLE", frequency: "MONTHLY", rateBps: 0, count: 1, firstDueDate: "2026-11-10" };
  assert.equal(renegotiationContract(position, { ...base, adjustmentCents: -(position.interestOpenCents + 1) }, TODAY).ok, false);
  assert.equal(renegotiationContract(position, { ...base, adjustmentCents: 0, firstDueDate: "2026-10-01" }, TODAY).ok, false);
});

test("RS3. capital: o principal em aberto volta e sai de novo, então o disponível não muda", () => {
  const before = build([old("op_a", 100_000)], [pay("op_a", 10_000)]);
  const position = renegotiationPosition(before.operations);
  const built = renegotiationContract(position, { modality: "SINGLE", frequency: "MONTHLY", rateBps: 500, count: 1, firstDueDate: "2026-11-10", adjustmentCents: 0 }, TODAY);
  assert.ok(built.ok);
  const operations = [
    old("op_a", 100_000, "RENEGOTIATED", { renegotiatedIntoId: "op_n", renegotiatedOn: TODAY, renegotiatedAt: "2026-10-17T10:00:00.000Z", renegotiatedPrincipalCents: position.principalOpenCents, renegotiatedInterestCents: position.interestOpenCents, settledAt: TODAY }),
    { ...old("op_n", built.contract.principalCents, "OPEN", { loanDate: TODAY, createdAt: "2026-10-17T10:00:00.001Z" }), ...built.contract },
  ];
  const after = build(operations, [pay("op_a", 10_000)]);
  assert.equal(after.summary.availableCents, before.summary.availableCents, "nenhum dinheiro sai nem entra");
  assert.equal(after.summary.lentCents, before.summary.lentCents, "o principal emprestado é o mesmo");
  assert.equal(after.summary.counts.active, 1);
  assert.equal(after.summary.counts.paid, 0);
  const oldView = after.operations.find((operation) => operation.id === "op_a");
  const newView = after.operations.find((operation) => operation.id === "op_n");
  assert.equal(oldView.state, "RENEGOTIATED");
  assert.equal(oldView.balanceCents, 0);
  assert.equal(oldView.renegotiatedIntoCode, newView.code);
  assert.deepEqual(newView.renegotiatedFrom.map((from) => [from.id, from.principalCents, from.interestCents]), [["op_a", position.principalOpenCents, position.interestOpenCents]]);
  assert.equal(after.summary.receivableCents, newView.balanceCents, "a carteira só cobra o contrato novo");
  // Extrato: a volta do principal vem antes da nova saída, no mesmo dia.
  const kinds = after.capitalLedger.filter((entry) => entry.date === TODAY && entry.kind !== "INITIAL").map((entry) => entry.kind).reverse();
  assert.deepEqual(kinds, ["RENEGOTIATION", "LOAN"]);
  assert.ok(after.capitalLedger.every((entry) => entry.balanceCents >= 0));
  // Relatório: o principal emprestado não conta duas vezes.
  const report = profitabilityReport(after.operations, { period: "CYCLE", from: "", to: "", status: "ALL" }, TODAY);
  assert.equal(report.totals.principalLentCents, 100_000);
  assert.equal(after.profitability.principalCents, 100_000);
});

test("RS4. multa vai só na última parcela: demais iguais, última = parcela + multa, total e juros incluem a multa", () => {
  const position = renegotiationPosition(build([old("op_a", 100_000)]).operations);
  const terms = { modality: "INSTALLMENT", frequency: "MONTHLY", rateBps: 500, count: 3, firstDueDate: "2026-11-10", adjustmentCents: 0 };
  const plain = renegotiationContract(position, terms, TODAY);
  const fined = renegotiationContract(position, { ...terms, penaltyCents: 10_000 }, TODAY);
  assert.ok(plain.ok && fined.ok);
  assert.equal(fined.contract.installmentCents, plain.contract.installmentCents, "parcelas normais não mudam");
  assert.equal(fined.contract.totalCents, plain.contract.totalCents + 10_000);
  assert.equal(fined.contract.interestCents, plain.contract.interestCents + 10_000);
  const schedule = amortizedSchedule({ ...fined.contract, paidCents: 0 }, 0);
  assert.equal(schedule.reduce((sum, item) => sum + item.amountCents, 0), fined.contract.totalCents);
  assert.equal(schedule[0].amountCents, schedule[1].amountCents);
  assert.equal(schedule[2].amountCents, schedule[1].amountCents + 10_000);
  // A simulação divide para baixo (a sobra dos centavos cai na última); o contrato arredonda para cima.
  const diff = fined.sim.payments[2].amountCents - fined.sim.payments[1].amountCents;
  assert.ok(diff >= 10_000 && diff < 10_000 + 3);
});
