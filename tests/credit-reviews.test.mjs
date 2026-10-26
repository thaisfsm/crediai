import { test } from "node:test";
import assert from "node:assert/strict";
import { capacityIndicator, reviewOf, PHASE_REVIEWS } from "../src/lib/credit/reviews.ts";

test("CR1. indicador de capacidade: parcela sem juros e peso na renda", () => {
  assert.deepEqual(capacityIndicator(600000, 12, 300000), { installmentCents: 50000, incomeShare: 16.7 });
  assert.deepEqual(capacityIndicator(100000, 3, null), { installmentCents: 33334, incomeShare: null });
  assert.equal(capacityIndicator(100000, 3, 0).incomeShare, null);
});

test("CR2. só as fases 2, 3 e 4 têm conferência; cada uma com itens próprios", () => {
  assert.deepEqual(Object.keys(PHASE_REVIEWS), ["IDENTITY", "DOCUMENTS", "CAPACITY"]);
  assert.equal(reviewOf("RECEIVED"), null);
  assert.equal(reviewOf("CAPACITY").checks.length, 4);
});
