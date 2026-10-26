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

import { evaluateProposal } from "../src/lib/credit/engine.ts";

test("CR3. motor: limite vazio passa; contrato, prazo e exposição por CPF barram; taxa fica para a oferta", () => {
  const none = { maxExposurePerCpfCents: null, maxTermMonths: null, maxContractCents: null, minRateBps: null };
  assert.equal(evaluateProposal({ requestedCents: 999999999, termMonths: 360 }, none, 5000000).passed, true);
  const policy = { maxExposurePerCpfCents: 1000000, maxTermMonths: 12, maxContractCents: 500000, minRateBps: 750 };
  assert.equal(evaluateProposal({ requestedCents: 500000, termMonths: 12 }, policy, 500000).passed, true, "no limite exato passa");
  const failed = (r) => r.rules.filter((rule) => rule.status === "FAIL").map((rule) => rule.label);
  assert.deepEqual(failed(evaluateProposal({ requestedCents: 500001, termMonths: 6 }, policy, 0)), ["Limite por contrato"]);
  assert.deepEqual(failed(evaluateProposal({ requestedCents: 100000, termMonths: 13 }, policy, 0)), ["Prazo máximo"]);
  assert.deepEqual(failed(evaluateProposal({ requestedCents: 100000, termMonths: 6 }, policy, 900001)), ["Exposição máxima por CPF"]);
  assert.equal(evaluateProposal({ requestedCents: 1, termMonths: 1 }, policy, 0).rules.at(-1).status, "LATER");
});
