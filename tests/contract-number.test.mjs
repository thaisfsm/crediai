import { test } from "node:test";
import assert from "node:assert/strict";
import { formatContractNumber, nextContractSequence } from "../src/lib/investors/contract-number.ts";

test("NC1. número do contrato: ANO.MÊS.DIA-0001 com a data de início", () => {
  assert.equal(formatContractNumber("2026-07-15", 1), "2026.07.15-0001");
  assert.equal(formatContractNumber("2026-12-03", 27), "2026.12.03-0027");
  assert.equal(formatContractNumber("2027-01-01", 10000), "2027.01.01-10000");
});

test("NC2. contador da carteira: próximo depois do maior número gerado; números digitados à mão não contam", () => {
  assert.equal(nextContractSequence([]), 1);
  assert.equal(nextContractSequence([null, "INV-2026/001", "REN-A2"]), 1);
  assert.equal(nextContractSequence(["2026.07.15-0001"]), 2);
  assert.equal(nextContractSequence(["2026.07.15-0001", "2026.08.01-0007", "2026.07.20-0003", "X-0099"]), 8);
});

import { addMonthsIso, addTermIso, installmentsFor, termFromDates } from "../src/lib/investors/rules.ts";

test("NC3. fórmulas do contrato: vencimento = último pagamento (início = 1º pagamento, + prazo − 1 meses), prazo = entre as datas, parcelas = prazo / periodicidade", () => {
  assert.equal(addMonthsIso("2026-08-25", 12), "2027-08-25");
  assert.equal(addMonthsIso("2026-01-31", 1), "2026-02-28");
  assert.equal(addTermIso("2026-08-06", 12, "MONTHS"), "2027-07-06");
  assert.equal(addTermIso("2026-08-25", 1, "MONTHS"), "2026-08-25");
  assert.equal(addTermIso("2026-08-25", 1, "YEARS"), "2027-07-25");
  assert.equal(addTermIso("2026-08-25", 45, "DAYS"), "2026-10-09");
  assert.deepEqual(termFromDates("2026-08-25", "2027-07-25"), { count: 12, unit: "MONTHS" });
  assert.deepEqual(termFromDates("2026-01-31", "2026-02-28"), { count: 2, unit: "MONTHS" });
  assert.deepEqual(termFromDates("2026-08-25", "2026-10-09"), { count: 45, unit: "DAYS" });
  assert.deepEqual(termFromDates("2026-08-25", "2026-08-25"), { count: 1, unit: "MONTHS" });
  assert.equal(termFromDates("2026-08-25", "2026-08-24"), null);
  assert.equal(installmentsFor(12, "MONTHS", "MONTHLY"), 12);
  assert.equal(installmentsFor(12, "MONTHS", "QUARTERLY"), 4);
  assert.equal(installmentsFor(10, "MONTHS", "QUARTERLY"), null);
  assert.equal(installmentsFor(1, "YEARS", "MONTHLY"), 12);
  assert.equal(installmentsFor(12, "MONTHS", "AT_MATURITY"), 1);
  assert.equal(installmentsFor(45, "DAYS", "MONTHLY"), null);
  assert.equal(installmentsFor(12, "MONTHS", ""), null);
});
