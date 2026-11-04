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

// ── Pro-rata temporis, taxa de resgate e tipos de liquidação ──────────────────────────────────────────────────────────
import { checkSettlementTerms, proRataYield, settlementTotals } from "../src/lib/investors/payables.ts";
const START = "2026-07-06";
const pr = (settledOn, payments = paid) => proRataYield({ items, payments, startDate: START, settledOn });
const terms = { kind: "COMPANY_DECISION", feeCents: 0, grossCents: 2056000, yieldCents: 0, overdueYieldCents: 0, allowAbove: false, settledOn: "2026-11-04", lastPaidOn: "2026-10-06" };

test("PR1 Gumercindo: R$ 600 ÷ 30 × 28 dias (06/10 → 04/11, 30E/360) = R$ 560; bruto R$ 20.560", () => {
  const result = pr("2026-11-04");
  assert.equal(result.elapsedDays, 28);
  assert.equal(result.periodDays, 30);
  assert.equal(result.periodStart, "2026-10-06");
  assert.equal(result.nextDueDate, "2026-11-06");
  assert.equal(result.cents, 56000);
  assert.match(result.formula, /R\$\s600,00 ÷ 30 × 28 dias = R\$\s560,00/);
  const plan = earlySettlementPlan({ amountCents: 2000000, items, payments: paid, settledOn: "2026-11-04" });
  assert.deepEqual(settlementTotals({ principalCents: plan.principalRemainingCents, yieldCents: 0, proRataCents: result.cents, feeCents: 0 }), { grossCents: 2056000, feeCents: 0, netCents: 2056000 });
});

test("PR2 liquidação exatamente no vencimento: pro-rata zero, o rendimento do dia fica nos vencidos (sem contar duas vezes)", () => {
  assert.equal(pr("2026-11-06").cents, 0);
  assert.equal(earlySettlementPlan({ amountCents: 2000000, items, payments: paid, settledOn: "2026-11-06" }).overdueYieldCents, 60000);
});

test("PR3 antes do próximo vencimento: 14 dias = R$ 280; antes do 1º vencimento conta do início do contrato", () => {
  assert.equal(pr("2026-10-20").cents, 28000);
  const none = proRataYield({ items, payments: [], startDate: START, settledOn: "2026-07-20" });
  assert.equal(none.periodStart, START);
  assert.equal(none.cents, 28000);
});

test("PR4 depois de um período já pago: o pago não volta; conta só desde o último vencimento", () => {
  const payments = [...paid, { scheduleItemId: "it4", kind: "YIELD", amountCents: 60000 }];
  const result = pr("2026-11-20", payments);
  assert.equal(result.periodStart, "2026-11-06");
  assert.equal(result.cents, 28000);
  assert.equal(earlySettlementPlan({ amountCents: 2000000, items, payments, settledOn: "2026-11-20" }).overdueYieldCents, 0);
});

test("PR5 rendimentos vencidos e não pagos ficam nos vencidos; o pro-rata cobre só o período em curso", () => {
  const plan = earlySettlementPlan({ amountCents: 2000000, items, payments: paid, settledOn: "2026-12-10" });
  assert.equal(plan.overdueYieldCents, 120000, "06/11 e 06/12");
  assert.equal(pr("2026-12-10").cents, 8000, "06/12 → 10/12 = 4 dias");
});

test("PR6 sem duplicidade: o que já foi pago do próximo rendimento é descontado; nunca juros sobre juros", () => {
  assert.equal(pr("2026-11-04", [...paid, { scheduleItemId: "it4", kind: "YIELD", amountCents: 20000 }]).cents, 36000);
  assert.equal(pr("2026-11-04", [...paid, { scheduleItemId: "it4", kind: "YIELD", amountCents: 60000 }]).cents, 0);
  assert.equal(pr("2026-11-04", [...paid, { scheduleItemId: "it4", kind: "PRINCIPAL", amountCents: 100000 }]).cents, 56000, "principal pago não mexe no rendimento");
  assert.equal(pr("2027-07-06").cents, 0, "sem rendimento a vencer, nada proporcional");
});

test("PR7–PR10 taxa zero, taxa manual, líquido e separação entre principal, rendimento e taxa", () => {
  assert.deepEqual(settlementTotals({ principalCents: 1000000, yieldCents: 0, proRataCents: 0, feeCents: 0 }), { grossCents: 1000000, feeCents: 0, netCents: 1000000 });
  assert.deepEqual(settlementTotals({ principalCents: 1000000, yieldCents: 30000, proRataCents: 14000, feeCents: 50000 }), { grossCents: 1044000, feeCents: 50000, netCents: 994000 });
  assert.deepEqual(checkSettlementTerms({ ...terms, kind: "INVESTOR_REQUEST", feeCents: 0 }), { ok: true });
  assert.deepEqual(checkSettlementTerms({ ...terms, kind: "INVESTOR_REQUEST", feeCents: 50000 }), { ok: true });
  assert.match(checkSettlementTerms({ ...terms, kind: "INVESTOR_REQUEST", feeCents: 2056001 }).error, /negativo/);
  assert.match(checkSettlementTerms({ ...terms, kind: "INVESTOR_REQUEST", feeCents: -1 }).error, /zero ou um valor positivo/);
  assert.match(checkSettlementTerms({ ...terms, kind: "INVESTOR_REQUEST", feeCents: null }).error, /zero ou um valor positivo/);
});

test("PR11–PR12 tipo expresso: taxa só no resgate pedido pelo investidor; decisão da empresa sem taxa", () => {
  assert.deepEqual(checkSettlementTerms(terms), { ok: true });
  assert.match(checkSettlementTerms({ ...terms, feeCents: 50000 }).error, /só se aplica ao resgate/);
  assert.match(checkSettlementTerms({ ...terms, kind: "" }).error, /Escolha o tipo/);
  assert.match(checkSettlementTerms({ ...terms, kind: "OUTRO" }).error, /Escolha o tipo/);
});

test("PR13 datas e valores incompatíveis: antes da última baixa e rendimento acima do vencido sem confirmação", () => {
  assert.match(checkSettlementTerms({ ...terms, settledOn: "2026-10-01" }).error, /última baixa/);
  assert.match(checkSettlementTerms({ ...terms, yieldCents: 10000 }).error, /acima do devido/);
  assert.deepEqual(checkSettlementTerms({ ...terms, yieldCents: 10000, allowAbove: true }), { ok: true });
});

test("PR14 convenção 30E/360 sem diferenças silenciosas: dia 31 conta 30 e fevereiro fecha o mês", () => {
  const month31 = [{ id: "a", dueDate: "2026-01-31", yieldCents: 60000 }, { id: "b", dueDate: "2026-02-28", yieldCents: 60000 }, { id: "c", dueDate: "2026-03-31", yieldCents: 60000 }];
  const a = proRataYield({ items: month31, payments: [], startDate: "2025-12-31", settledOn: "2026-02-14" });
  assert.equal(a.periodDays, 28); // 31/01 → 28/02 = 28 dias comerciais (o período dele)
  assert.equal(a.cents, Math.round(60000 * 14 / 28));
  const b = proRataYield({ items: month31, payments: [], startDate: "2025-12-31", settledOn: "2026-03-15" });
  assert.equal(b.periodDays, 32);
  assert.ok(b.cents <= 60000);
});
