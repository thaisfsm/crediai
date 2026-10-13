import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { chartDateLabel, chartGeometry } from "../src/lib/finance/chart.ts";

// Tooltip do gráfico "Evolução da carteira": cada ponto mostra a própria data e o próprio saldo a receber.
const TODAY = "2026-10-13";
const operation = {
  id: "op1", clientId: "c1", clientName: "Cliente Teste", principalCents: 9_000_000, interestRateBps: 1000, interestCents: 900_000, totalCents: 9_900_000,
  loanDate: "2026-07-01", dueDate: "2026-12-01", firstDueDate: "2026-12-01", status: "OPEN", settledAt: null,
  calculationRule: "RATE_PER_OPERATION_SINGLE_PAYMENT_V1", createdAt: "2026-07-01T10:00:00Z",
};
const pay = (id, amountCents, paidAt) => ({ id, operationId: "op1", clientName: "Cliente Teste", amountCents, paidAt, notes: null, createdAt: `${paidAt}T12:00:00Z` });
const portfolio = buildPortfolio({
  initialCapitalCents: 20_000_000, hasWallet: true, operations: [operation], today: TODAY,
  payments: [pay("p1", 100_000, "2026-08-15"), pay("p2", 153_400, "2026-10-01"), pay("p3", 10_000, "2026-10-10")],
});
const brl = (text) => text.replace(/\s/g, " ");

test("T1. data do ponto no formato dd/mm/aaaa, sem fuso", () => {
  assert.equal(chartDateLabel("2026-10-13"), "13/10/2026");
  assert.equal(chartDateLabel("2026-01-05"), "05/01/2026");
});

test("T2. 7D: um ponto por dia, cada um com a sua data e o seu saldo", () => {
  const { points } = chartGeometry(portfolio.chart["7D"]);
  assert.deepEqual(points.map((point) => point.dateLabel), ["07/10/2026", "08/10/2026", "09/10/2026", "10/10/2026", "11/10/2026", "12/10/2026", "13/10/2026"]);
  assert.deepEqual(points.map((point) => brl(point.valueLabel)), ["R$ 96.466,00", "R$ 96.466,00", "R$ 96.466,00", "R$ 96.366,00", "R$ 96.366,00", "R$ 96.366,00", "R$ 96.366,00"]);
});

test("T3. 30D e 90D: datas espaçadas no período e valores do próprio dia (não o saldo atual)", () => {
  const thirty = chartGeometry(portfolio.chart["30D"]).points;
  assert.deepEqual(thirty.map((point) => point.dateLabel), ["13/09/2026", "18/09/2026", "23/09/2026", "28/09/2026", "03/10/2026", "08/10/2026", "13/10/2026"]);
  assert.deepEqual(thirty.map((point) => brl(point.valueLabel)), ["R$ 98.000,00", "R$ 98.000,00", "R$ 98.000,00", "R$ 98.000,00", "R$ 96.466,00", "R$ 96.466,00", "R$ 96.366,00"]);
  const ninety = chartGeometry(portfolio.chart["90D"]).points;
  assert.deepEqual(ninety.map((point) => point.dateLabel), ["15/07/2026", "30/07/2026", "14/08/2026", "29/08/2026", "13/09/2026", "28/09/2026", "13/10/2026"]);
  assert.deepEqual(ninety.map((point) => brl(point.valueLabel)), ["R$ 99.000,00", "R$ 99.000,00", "R$ 99.000,00", "R$ 98.000,00", "R$ 98.000,00", "R$ 98.000,00", "R$ 96.366,00"]);
});

test("T4. o tooltip usa exatamente o valor e a data da série, na mesma posição da bolinha", () => {
  for (const period of ["7D", "30D", "90D"]) {
    const series = portfolio.chart[period];
    const { points, top } = chartGeometry(series);
    assert.equal(points.length, series.values.length);
    points.forEach((point, index) => {
      assert.equal(point.cents, series.values[index]);
      assert.equal(point.date, series.dates[index]);
      assert.equal(point.x, 96 + (index / (series.values.length - 1)) * 592);
      assert.equal(point.y, 175 - (series.values[index] / top) * 147);
      assert.ok(!point.valueLabel.includes("Evolução"));
    });
  }
});

test("T5. carteira vazia: pontos com R$ 0,00 e a data de cada dia", () => {
  const empty = buildPortfolio({ initialCapitalCents: 0, hasWallet: true, operations: [], payments: [], today: TODAY });
  const { points } = chartGeometry(empty.chart["7D"]);
  assert.equal(points.length, 7);
  assert.ok(points.every((point) => brl(point.valueLabel) === "R$ 0,00"));
  assert.equal(points[0].dateLabel, "07/10/2026");
});
