import { test } from "node:test";
import assert from "node:assert/strict";
import { portfolioLimitBlocksCash } from "../src/lib/finance/cash-limit.ts";

test("alerta quando o máximo da carteira deixa menos espaço que o caixa combinado disponível", () => {
  assert.equal(portfolioLimitBlocksCash(379665, 460500), true);
  assert.equal(portfolioLimitBlocksCash(0, 460500), true);
});

test("sem alerta sem máximo definido ou quando o máximo comporta o caixa", () => {
  assert.equal(portfolioLimitBlocksCash(null, 460500), false);
  assert.equal(portfolioLimitBlocksCash(460500, 460500), false);
  assert.equal(portfolioLimitBlocksCash(1000000, 460500), false);
  assert.equal(portfolioLimitBlocksCash(0, 0), false);
});
