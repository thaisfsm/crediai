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
