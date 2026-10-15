import { test } from "node:test";
import assert from "node:assert/strict";
import { editReason, operationChanges } from "../src/lib/finance/operation-edit.ts";

const base = {
  clientId: "c1", clientName: "Ana", principalCents: 100_000, interestRateBps: 3000, interestCents: 30_000, totalCents: 130_000, loanDate: "2026-10-01",
  dueDate: "2026-11-01", firstDueDate: "2026-11-01", installmentCount: null, installmentCents: null, calculationRule: "RATE_PER_OPERATION_SINGLE_PAYMENT_V1", modality: "SINGLE", frequency: "MONTHLY",
};

test("OE1. antes e depois: só os campos que mudaram, escritos para leitura", () => {
  assert.deepEqual(operationChanges(base, base), []);
  const changes = operationChanges(base, { ...base, principalCents: 120_000, interestCents: 36_000, totalCents: 156_000, clientId: "c2", clientName: "Bia" });
  assert.deepEqual(changes.map((change) => change.field), ["Cliente", "Valor emprestado", "Juros", "Total a receber"]);
  assert.equal(changes[0].before, "Ana");
  assert.equal(changes[0].after, "Bia");
  assert.match(changes[1].before, /1\.000,00/);
  assert.match(changes[1].after, /1\.200,00/);
});

test("OE2. parcelado: parcelas, valor da parcela e vencimentos", () => {
  const before = { ...base, modality: "INSTALLMENT", installmentCount: 3, installmentCents: 30_000, principalCents: 60_000, interestCents: 30_000, totalCents: 90_000, dueDate: "2026-12-06", firstDueDate: "2026-11-06", calculationRule: "FIXED_BIWEEKLY_INSTALLMENTS_V1", frequency: "BIWEEKLY" };
  const after = { ...before, installmentCount: 4, totalCents: 120_000, interestCents: 60_000, dueDate: "2026-12-21" };
  assert.deepEqual(operationChanges(before, after).map((change) => [change.field, change.before, change.after]).filter(([field]) => field !== "Juros" && field !== "Total a receber"),
    [["Último vencimento", "06/12/2026", "21/12/2026"], ["Quantidade de parcelas", "3", "4"]]);
});

test("OE3. motivo obrigatório", () => {
  assert.equal(editReason("").ok, false);
  assert.equal(editReason("  a ").ok, false);
  assert.deepEqual(editReason("  valor   digitado errado "), { ok: true, value: "valor digitado errado" });
});
