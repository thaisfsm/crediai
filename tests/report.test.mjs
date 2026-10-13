import { test } from "node:test";
import assert from "node:assert/strict";
import { periodRange, profitabilityReport } from "../src/lib/finance/report.ts";

const op = (id, clientId, clientName, status, state, loanDate, principalCents, payments, extra = {}) => ({
  id, clientId, clientName, status, state, loanDate, principalCents, payments, interestRemainingCents: 0, balanceCents: 0, ...extra,
});
const pay = (paidAt, amountCents, interestCents) => ({ paidAt, amountCents, interestCents, principalCents: amountCents - interestCents });

const operations = [
  op("o1", "c1", "Ana", "OPEN", "ACTIVE", "2026-09-10", 100_000, [pay("2026-09-25", 30_000, 30_000), pay("2026-10-05", 50_000, 0)], { interestRemainingCents: 30_000, balanceCents: 80_000 }),
  op("o2", "c1", "Ana", "PAID", "PAID", "2026-08-01", 50_000, [pay("2026-08-30", 65_000, 15_000)]),
  op("o3", "c2", "Bia", "OPEN", "OVERDUE", "2026-10-02", 200_000, [], { interestRemainingCents: 60_000, balanceCents: 260_000 }),
  op("o4", "c2", "Bia", "CANCELED", "CANCELED", "2026-10-03", 999_999, []),
];

test("RE1. períodos: este mês, mês passado (inclusive virada de ano), últimos 30 dias, personalizado e ciclo", () => {
  assert.deepEqual(periodRange({ period: "THIS_MONTH", from: "", to: "" }, "2026-10-13"), { from: "2026-10-01", to: "2026-10-13" });
  assert.deepEqual(periodRange({ period: "LAST_MONTH", from: "", to: "" }, "2026-10-13"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(periodRange({ period: "LAST_MONTH", from: "", to: "" }, "2027-01-05"), { from: "2026-12-01", to: "2026-12-31" });
  assert.deepEqual(periodRange({ period: "LAST_30", from: "", to: "" }, "2026-10-13"), { from: "2026-09-14", to: "2026-10-13" });
  assert.deepEqual(periodRange({ period: "CUSTOM", from: "2026-09-01", to: "" }, "2026-10-13"), { from: "2026-09-01", to: null });
  assert.deepEqual(periodRange({ period: "CYCLE", from: "2026-09-01", to: "2026-09-02" }, "2026-10-13"), { from: null, to: null });
});

test("RE2. todo o ciclo: soma tudo, ignora excluídas, ordena pelo lucro realizado", () => {
  const report = profitabilityReport(operations, { period: "CYCLE", from: "", to: "", status: "ALL" }, "2026-10-13");
  assert.deepEqual(report.clients.map((client) => client.clientName), ["Ana", "Bia"]);
  assert.deepEqual(report.totals, { principalLentCents: 350_000, principalReceivedCents: 100_000, interestReceivedCents: 45_000, receivedCents: 145_000, paymentCount: 3, interestRemainingCents: 90_000, balanceCents: 340_000, operationCount: 3 });
});

test("RE3. período: recebidos pela data do pagamento, emprestado pela data do empréstimo, saldo de hoje", () => {
  const september = profitabilityReport(operations, { period: "CUSTOM", from: "2026-09-01", to: "2026-09-30", status: "ALL" }, "2026-10-13");
  assert.equal(september.clients.length, 1);
  assert.deepEqual(september.totals, { principalLentCents: 100_000, principalReceivedCents: 0, interestReceivedCents: 30_000, receivedCents: 30_000, paymentCount: 1, interestRemainingCents: 30_000, balanceCents: 80_000, operationCount: 1 });
  const october = profitabilityReport(operations, { period: "THIS_MONTH", from: "", to: "", status: "ALL" }, "2026-10-13");
  // o1 entra pelo pagamento de outubro (sem contar o principal emprestado em setembro); o3 pelo empréstimo.
  assert.deepEqual(october.totals, { principalLentCents: 200_000, principalReceivedCents: 50_000, interestReceivedCents: 0, receivedCents: 50_000, paymentCount: 1, interestRemainingCents: 90_000, balanceCents: 340_000, operationCount: 2 });
});

test("RE4. situação: em aberto, em atraso e quitadas", () => {
  const ids = (status) => profitabilityReport(operations, { period: "CYCLE", from: "", to: "", status }, "2026-10-13").clients.flatMap((client) => client.operations.map(({ operation }) => operation.id));
  assert.deepEqual(ids("OPEN").sort(), ["o1", "o3"]);
  assert.deepEqual(ids("OVERDUE"), ["o3"]);
  assert.deepEqual(ids("PAID"), ["o2"]);
  assert.deepEqual(ids("ALL").sort(), ["o1", "o2", "o3"]);
});
