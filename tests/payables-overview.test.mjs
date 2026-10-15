// Contas a pagar no Dashboard e nas abas da tela: o resumo do dia (payablesOverview) usado pelos dois, as abas e a
// descrição das obrigações. Previsto, pendente e pago ficam separados e nada é contado duas vezes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildObligations, obligationDescription, parsePayableTab, payablesOverview, payablesSections } from "../src/lib/investors/payables.ts";

const TODAY = "2026-10-15";
const investment = (id, extra = {}) => ({ id, investorId: `inv-${id}`, investorName: `Investidor ${id}`, contractNumber: `C-${id}`, status: "ACTIVE", startDate: "2026-01-10", amountCents: 1_000_000, ...extra });
const item = (id, investmentId, number, dueDate, yieldCents, principalCents = 0, description = null) => ({ id, investmentId, number, dueDate, yieldCents, principalCents, description });
const pay = (id, scheduleItemId, kind, amountCents, paidOn) => ({ id, scheduleItemId, kind, amountCents, paidOn, method: "PIX", reference: null, notes: null, createdAt: `${paidOn}T12:00:00.000Z`, createdBy: "Teste", capitalMovementId: `cap-${id}` });

// Contrato "a": mensal com principal no fim; contrato "b": cronograma personalizado (datas irregulares, principal em duas partes).
const obligations = (payments = []) => buildObligations({
  investments: [investment("a"), investment("b", { investorName: "Beatriz" })],
  items: [
    item("a1", "a", 1, "2026-09-15", 15_000), item("a2", "a", 2, TODAY, 15_000), item("a3", "a", 3, "2026-11-15", 15_000, 1_000_000),
    item("b1", "b", 1, "2026-10-03", 0, 500_000, "Metade do principal"), item("b2", "b", 2, TODAY, 7_500, 0), item("b3", "b", 3, "2026-10-19", 7_500, 500_000), item("b4", "b", 4, "2026-12-29", 2_000),
  ],
  payments, today: TODAY,
});

test("PO1. dia sem baixas: previsto = a pagar hoje; vencidas e próximas separadas; nada pago", () => {
  const view = payablesOverview(obligations(), TODAY);
  assert.equal(view.expectedTodayCents, 22_500);
  assert.equal(view.dueTodayCents, 22_500);
  assert.equal([view.pendingTodayCount, view.dueTodayCount].join(), "2,2");
  assert.equal(view.overdueCents, 15_000 + 500_000);
  assert.equal(view.overdueCount, 2);
  assert.equal(view.paidTodayCents, 0);
  // Próximos 7 dias: só a linha b3 (rendimento e principal separados), não a de novembro nem a de dezembro.
  assert.equal(view.upcomingUntil, "2026-10-22");
  assert.deepEqual(view.upcomingList.map((o) => o.key), ["b3:YIELD", "b3:PRINCIPAL"]);
  assert.equal(view.upcomingCents, 507_500);
});

test("PO2. depois de baixas: pago hoje sobe, o pendente cai, a paga não conta como pendente nem duas vezes", () => {
  const view = payablesOverview(obligations([pay("p1", "a2", "YIELD", 15_000, TODAY), pay("p2", "b2", "YIELD", 2_500, TODAY), pay("p3", "a1", "YIELD", 15_000, TODAY), pay("p4", "b1", "PRINCIPAL", 100_000, "2026-10-10")]), TODAY);
  assert.equal(view.expectedTodayCents, 22_500, "o previsto do dia não muda com a baixa");
  assert.equal(view.dueTodayCents, 5_000);
  assert.equal(view.pendingTodayCount, 1);
  assert.equal(view.dueTodayCount, 2);
  // Pago hoje: as baixas com data de hoje, inclusive a de uma vencida (a1); a de 10/10 não entra.
  assert.equal(view.paidTodayCents, 32_500);
  assert.equal(view.paidTodayCount, 3);
  assert.equal(view.overdueCents, 400_000);
  assert.equal(view.overdueCount, 1);
  // Lista de hoje: pendentes primeiro, depois a paga; cada obrigação uma vez.
  assert.deepEqual(view.todayList.map((o) => [o.key, o.status]), [["b2:YIELD", "PARCIAL"], ["a2:YIELD", "PAGA"]]);
});

test("PO3. abas e seções: Hoje por padrão; a aba Hoje inclui a paga do dia, as outras seções não se sobrepõem", () => {
  assert.equal(parsePayableTab(undefined), "hoje");
  assert.equal(parsePayableTab("vencidos"), "vencidos");
  assert.equal(parsePayableTab("constructor"), "hoje");
  assert.equal(parsePayableTab("<script>"), "hoje");
  const list = obligations([pay("p1", "a2", "YIELD", 15_000, TODAY)]);
  const sections = payablesSections(list, TODAY);
  assert.deepEqual(sections.today.map((o) => o.key), ["b2:YIELD", "a2:YIELD"]);
  const keys = [...sections.overdue, ...sections.dueToday, ...sections.upcoming, ...sections.paid].map((o) => o.key);
  assert.equal(keys.length, list.length);
  assert.equal(new Set(keys).size, list.length);
});

test("PO4. descrição: tipo e observação da linha, ou tipo e parcela; origem contrato de investidor", () => {
  const list = obligations();
  assert.equal(obligationDescription(list.find((o) => o.key === "b1:PRINCIPAL")), "Devolução de principal · Metade do principal");
  assert.equal(obligationDescription(list.find((o) => o.key === "a2:YIELD")), "Rendimento · parcela 2");
  assert.ok(list.every((o) => o.source === "INVESTOR"));
});

test("PO5. carteira sem obrigações: tudo zero, sem valores inventados", () => {
  const view = payablesOverview([], TODAY);
  for (const key of ["expectedTodayCents", "dueTodayCents", "pendingTodayCount", "paidTodayCents", "overdueCents", "upcomingCents"]) assert.equal(view[key], 0, key);
  assert.deepEqual([view.todayList, view.upcomingList, view.overdueList], [[], [], []]);
});
