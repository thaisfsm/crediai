import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { bandOf, delinquencyOverview } from "../src/lib/finance/delinquency.ts";

// Gestão de inadimplência: faixas pelo mesmo atraso das Cobranças (próxima obrigação em aberto vencida).
const TODAY = "2026-10-28";
const day = (offset) => { const date = new Date(`${TODAY}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
const single = (id, due, extra = {}) => ({
  id, clientId: `c_${id}`, clientName: `Cliente ${id}`, principalCents: 100000, interestRateBps: 1000, interestCents: 10000, totalCents: 110000,
  loanDate: "2026-01-01", dueDate: due, firstDueDate: due, status: "OPEN", settledAt: null, calculationRule: "RATE_PER_OPERATION_SINGLE_PAYMENT_V1", createdAt: "2026-01-01T10:00:00Z", ...extra,
});
const build = (operations, payments = []) => buildPortfolio({ initialCapitalCents: 10_000_000, hasWallet: true, operations, payments, today: TODAY });

test("D1. limites das faixas: 1-30, 31-60, 61-90 e 91+ (PDD)", () => {
  assert.deepEqual([1, 30, 31, 60, 61, 90, 91, 400].map(bandOf), ["1-30", "1-30", "31-60", "31-60", "61-90", "61-90", "91+", "91+"]);
});

test("D2. cada operação vencida cai na faixa certa; hoje, futuras, quitadas e canceladas ficam fora", () => {
  const portfolio = build([
    single("d1", day(-1)), single("d30", day(-30)), single("d31", day(-31)), single("d75", day(-75)), single("d90", day(-90)), single("d91", day(-91)), single("d200", day(-200)),
    single("hoje", TODAY), single("futura", day(10)), single("paga", day(-50), { status: "PAID", settledAt: day(-40) }), single("cancelada", day(-50), { status: "CANCELED" }),
  ]);
  const overview = delinquencyOverview(portfolio.operations);
  const ids = Object.fromEntries(overview.bands.map((band) => [band.key, band.operations.map((operation) => operation.id)]));
  assert.deepEqual(ids, { "1-30": ["d30", "d1"], "31-60": ["d31"], "61-90": ["d90", "d75"], "91+": ["d200", "d91"] });
  // O total de atrasadas é o mesmo contador "em atraso" das Cobranças.
  assert.equal(overview.operationCount, portfolio.summary.counts.overdue);
  assert.equal(overview.operationCount, portfolio.charges["Em atraso"].length);
  assert.equal(overview.operations.find((operation) => operation.id === "d75").daysLate, 75);
});

test("D3. valores por faixa: saldo e principal em aberto, clientes distintos e % do total a receber", () => {
  const portfolio = build([
    single("a", day(-10), { clientId: "c_x" }), single("b", day(-20), { clientId: "c_x" }), single("c", day(-100)), single("futura", day(5)),
  ], [{ id: "p1", operationId: "a", clientName: "x", amountCents: 5000, paidAt: day(-5), notes: null, createdAt: `${day(-5)}T12:00:00Z` }]);
  const overview = delinquencyOverview(portfolio.operations);
  const first = overview.bands[0];
  const view = (id) => portfolio.operations.find((operation) => operation.id === id);
  assert.equal(first.operationCount, 2);
  assert.equal(first.clientCount, 1);
  assert.equal(first.balanceCents, view("a").balanceCents + view("b").balanceCents);
  assert.equal(first.principalRemainingCents, view("a").principalRemainingCents + view("b").principalRemainingCents);
  assert.equal(overview.bands[3].balanceCents, view("c").balanceCents);
  assert.equal(overview.receivableCents, portfolio.summary.receivableCents);
  assert.equal(overview.shareBps, Math.round((overview.balanceCents * 10_000) / portfolio.summary.receivableCents));
});

test("D4. carteira sem atraso: tudo zerado", () => {
  const overview = delinquencyOverview(build([single("futura", day(5))]).operations);
  assert.equal(overview.operationCount, 0);
  assert.equal(overview.shareBps, 0);
  assert.ok(overview.bands.every((band) => band.operationCount === 0 && band.balanceCents === 0));
});
