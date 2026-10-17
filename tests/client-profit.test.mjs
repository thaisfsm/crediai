import { test } from "node:test";
import assert from "node:assert/strict";
import { clientProfitHistory } from "../src/lib/finance/client-profit.ts";

const op = (id, clientId, status, loanDate, principalCents, interestPaidCents, extra = {}) => ({
  id, code: id.toUpperCase(), clientId, status, loanDate, principalCents, interestPaidCents, paidCents: interestPaidCents, principalRemainingCents: 0, balanceCents: 0, ...extra,
});

test("CP1. lucro do cliente soma todos os ciclos, só juros recebidos, e ignora excluídas e outros clientes", () => {
  const h = clientProfitHistory([
    op("a1", "c1", "PAID", "2026-07-01", 100_000, 3_000, { cycleNumber: 1, paidCents: 103_000 }),
    op("a2", "c1", "OPEN", "2026-10-02", 50_000, 7_500, { cycleNumber: 2, principalRemainingCents: 50_000, balanceCents: 57_500 }),
    op("a3", "c1", "CANCELED", "2026-10-03", 999_999, 0),
    op("b1", "c2", "PAID", "2026-09-01", 10_000, 9_999),
  ], "c1");
  assert.equal(h.operationCount, 2);
  assert.equal(h.interestReceivedCents, 10_500);
  assert.equal(h.paidContractsProfitCents, 3_000);
  assert.equal(h.principalLentCents, 150_000);
  assert.equal(h.principalOpenCents, 50_000);
  assert.equal(h.exposureAfterProfitCents, 39_500);
  assert.equal(h.coveragePercent, 21);
  assert.deepEqual(h.rows.map((r) => r.id), ["a2", "a1"]);
});

test("CP2. lucro maior que o principal em aberto zera o risco; sem principal em aberto não há cobertura", () => {
  const covered = clientProfitHistory([op("a1", "c1", "OPEN", "2026-10-01", 10_000, 20_000, { principalRemainingCents: 10_000 })], "c1");
  assert.equal(covered.exposureAfterProfitCents, 0);
  assert.equal(covered.coveragePercent, 200);
  const none = clientProfitHistory([op("a1", "c1", "PAID", "2026-10-01", 10_000, 3_000)], "c1");
  assert.equal(none.coveragePercent, null);
  assert.equal(none.paidContractsProfitCents, 3_000);
  assert.equal(clientProfitHistory([], "c1").operationCount, 0);
});
