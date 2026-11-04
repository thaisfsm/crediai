// Liquidação antecipada do contrato de investidor: plano (o que é encerrado, o que falta de principal, rendimentos
// vencidos × futuros) e conferências antes de gravar. Caso do print: R$ 20.000, 12 × R$ 600, 3 pagas, principal no fim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEarlySettlement, earlySettlementPlan } from "../src/lib/investors/payables.ts";

const month = (n) => `${n <= 5 ? 2026 : 2027}-${String(((n + 7 - 1) % 12) + 1).padStart(2, "0")}-06`;
const items = Array.from({ length: 12 }, (_, i) => ({ id: `it${i + 1}`, dueDate: month(i + 1), yieldCents: 60000, principalCents: i === 11 ? 2000000 : 0 }));
const paid = [1, 2, 3].map((n) => ({ scheduleItemId: `it${n}`, kind: "YIELD", amountCents: 60000 }));

test("LA1 contrato do print: devolve R$ 20.000, encerra 9 parcelas (R$ 25.400 em aberto), sem mexer nas pagas", () => {
  const plan = earlySettlementPlan({ amountCents: 2000000, items, payments: paid, settledOn: "2026-11-04" });
  assert.equal(month(4), "2026-11-06");
  assert.equal(plan.principalRemainingCents, 2000000);
  assert.equal(plan.principalPaidCents, 0);
  assert.equal(plan.openScheduleCents, 2540000);
  assert.equal(plan.closedCount, 9);
  assert.deepEqual(plan.removeItemIds, ["it4", "it5", "it6", "it7", "it8", "it9", "it10", "it11", "it12"]);
  assert.deepEqual(plan.trimItems, []);
  assert.equal(plan.overdueYieldCents, 0);
  assert.equal(plan.futureYieldCents, 540000);
});

test("LA2 rendimento vencido até a data vira sugestão; parcela parcial fica só com o pago", () => {
  const payments = [...paid, { scheduleItemId: "it4", kind: "YIELD", amountCents: 20000 }, { scheduleItemId: "it12", kind: "PRINCIPAL", amountCents: 500000 }];
  const plan = earlySettlementPlan({ amountCents: 2000000, items, payments, settledOn: "2026-12-10" });
  assert.equal(plan.principalPaidCents, 500000);
  assert.equal(plan.principalRemainingCents, 1500000);
  assert.equal(plan.overdueYieldCents, 40000 + 60000);
  assert.deepEqual(plan.trimItems, [{ id: "it4", yieldCents: 20000, principalCents: 0 }, { id: "it12", yieldCents: 0, principalCents: 500000 }]);
  assert.ok(!plan.removeItemIds.includes("it4") && !plan.removeItemIds.includes("it12"));
});

test("LA3 conferências: só ativo, não renovado, datas, rendimento e algo a pagar", () => {
  const base = { status: "ACTIVE", renewed: false, settledOn: "2026-11-04", today: "2026-11-04", startDate: "2026-07-06", cycleStartedOn: "2026-01-01", principalRemainingCents: 2000000, yieldCents: 0 };
  assert.deepEqual(checkEarlySettlement(base), { ok: true });
  assert.match(checkEarlySettlement({ ...base, status: "CLOSED" }).error, /encerrado/);
  assert.match(checkEarlySettlement({ ...base, status: "CANCELED" }).error, /ativo/);
  assert.match(checkEarlySettlement({ ...base, renewed: true }).error, /renovado/);
  assert.match(checkEarlySettlement({ ...base, settledOn: "2026-11-05" }).error, /depois de hoje/);
  assert.match(checkEarlySettlement({ ...base, settledOn: "2026-07-01" }).error, /início do contrato/);
  assert.match(checkEarlySettlement({ ...base, cycleStartedOn: "2026-11-01", settledOn: "2026-10-30" }).error, /ciclo/);
  assert.match(checkEarlySettlement({ ...base, yieldCents: -1 }).error, /rendimento/);
  assert.match(checkEarlySettlement({ ...base, principalRemainingCents: 0 }).error, /nada a liquidar/);
});

test("LA4 código: só a carteira da sessão, nenhuma baixa ou saída de capital alterada/apagada, auditoria", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/app/investidores/settlement-actions.ts", "utf8");
  assert.ok(source.includes("withTenantContext(") && !source.includes("withInvestorContext") && !source.includes("withPlatformContext"));
  assert.ok(!/(update|delete)\((investmentPayments|capitalMovements|investmentCapitalEntries)\)/.test(source), "baixas e capital só recebem inserções");
  assert.deepEqual([...source.matchAll(/tx\.delete\((\w+)\)/g)].map((match) => match[1]), ["investmentScheduleItems"]);
  assert.ok(source.includes("inArray(investmentScheduleItems.id, plan.removeItemIds)"), "só as linhas sem baixa saem");
  assert.ok(source.includes('action: "INVESTMENT_SETTLED_EARLY"') && source.includes("checkOutflow(") && source.includes('.for("update")'));
});
