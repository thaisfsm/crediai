import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio, compareCharges } from "../src/lib/finance/portfolio.ts";
import { dueDates, operationLedger } from "../src/lib/finance/rules.ts";

// Ordem das Cobranças: pela próxima obrigação em aberto (a vencida há mais tempo primeiro), em todas as abas.
const TODAY = "2026-10-13";
const base = (id, extra) => ({
  id, clientId: `c_${id}`, clientName: `Cliente ${id}`, principalCents: 100000, interestRateBps: 1000, interestCents: 10000, totalCents: 110000,
  loanDate: "2026-08-01", status: "OPEN", settledAt: null, calculationRule: "RATE_PER_OPERATION_SINGLE_PAYMENT_V1", createdAt: "2026-08-01T10:00:00Z", ...extra,
});
const single = (id, due, extra = {}) => base(id, { dueDate: due, firstDueDate: due, ...extra });
// Parcelado com parcelas mensais de R$ 1.000 a partir de firstDue.
const installment = (id, firstDue, count, extra = {}) => base(id, {
  modality: "INSTALLMENT", installmentCount: count, installmentCents: 100000, principalCents: count * 90000, interestCents: count * 10000, totalCents: count * 100000,
  firstDueDate: firstDue, dueDate: firstDue, calculationRule: "FIXED_MONTHLY_INSTALLMENTS_V1", ...extra,
});
const biweekly = (id, firstDue) => single(id, firstDue, { frequency: "BIWEEKLY", loanDate: "2026-09-01" });
let seq = 0;
const pay = (operationId, amountCents, paidAt) => ({ id: `p${++seq}`, operationId, clientName: "x", amountCents, paidAt, notes: null, createdAt: `${paidAt}T12:00:${String(seq % 60).padStart(2, "0")}Z` });
const build = (operations, payments = []) => buildPortfolio({ initialCapitalCents: 10_000_000, hasWallet: true, operations, payments, today: TODAY });
const tab = (portfolio, name) => portfolio.charges[name].map((charge) => charge.operationId);
const view = (portfolio, id) => portfolio.operations.find((operation) => operation.id === id);

test("C1. vencidas: a vencida há mais tempo primeiro (Em atraso e Em aberto)", () => {
  const portfolio = build([single("recente", "2026-10-12"), single("antiga", "2026-09-01"), single("meio", "2026-10-01")]);
  assert.deepEqual(tab(portfolio, "Em atraso"), ["antiga", "meio", "recente"]);
  assert.deepEqual(portfolio.chargeOrder, ["antiga", "meio", "recente"]);
});

test("C2. futuras em ordem crescente (Amanhã, Próximas e Em aberto)", () => {
  const portfolio = build([single("d30", "2026-11-12"), single("d7", "2026-10-20"), single("d1", "2026-10-14"), single("d3", "2026-10-16")]);
  assert.deepEqual(tab(portfolio, "Amanhã"), ["d1"]);
  assert.deepEqual(tab(portfolio, "Próximas"), ["d1", "d3", "d7"]);
  assert.deepEqual(portfolio.chargeOrder, ["d1", "d3", "d7", "d30"]);
});

test("C3. Em aberto: vencidas, depois as de hoje, depois as futuras", () => {
  const portfolio = build([single("futura", "2026-10-25"), single("hoje", TODAY), single("amanha", "2026-10-14"), single("vencida", "2026-10-01"), single("ontem", "2026-10-12")]);
  assert.deepEqual(portfolio.chargeOrder, ["vencida", "ontem", "hoje", "amanha", "futura"]);
  assert.deepEqual(tab(portfolio, "Hoje"), ["hoje"]);
});

test("C4. parcelado: usa a primeira parcela não quitada, nunca uma futura", () => {
  // 1ª parcela (13/09) sem pagamento: a operação está atrasada desde 13/09, mesmo com a 2ª vencendo hoje.
  const late = build([single("x", "2026-10-01"), installment("p", "2026-09-13", 3)]);
  assert.equal(view(late, "p").nextOpenDueDate, "2026-09-13");
  assert.deepEqual(tab(late, "Em atraso"), ["p", "x"]);
  assert.deepEqual(tab(late, "Hoje"), []);
  // Com a 1ª quitada, a obrigação aberta é a 2ª (hoje).
  const paid = build([single("x", "2026-10-01"), installment("p", "2026-09-13", 3)], [pay("p", 100000, "2026-09-13")]);
  assert.equal(view(paid, "p").nextOpenDueDate, TODAY);
  assert.deepEqual(tab(paid, "Hoje"), ["p"]);
  assert.deepEqual(paid.chargeOrder, ["x", "p"]);
});

test("C5. pagamento parcial: a obrigação continua aberta na data de vencimento original", () => {
  // Parcela de R$ 1.000 com R$ 400 pagos: continua em 13/09, antes da que venceu em 01/10.
  const parcel = build([single("x", "2026-10-01"), installment("p", "2026-09-13", 3)], [pay("p", 40000, "2026-09-20")]);
  assert.equal(view(parcel, "p").nextInstallment.state, "PARTIAL");
  assert.deepEqual(tab(parcel, "Em atraso"), ["p", "x"]);
  // Pagamento único com só parte dos juros pagos: o período não renova, segue em 05/10.
  const interest = build([single("y", "2026-10-10"), single("s", "2026-10-05")], [pay("s", 4000, "2026-10-05")]);
  assert.equal(view(interest, "s").nextOpenDueDate, "2026-10-05");
  assert.equal(view(interest, "s").renewalCount, 0);
  assert.deepEqual(tab(interest, "Em atraso"), ["s", "y"]);
});

test("C6. juros pagos com principal em aberto: vale o período seguinte gerado pelo motor", () => {
  // Mensal: juros de 10/10 pagos → período até 10/11; passa para depois da que vence em 20/10.
  const monthly = build([single("m", "2026-10-10"), single("y", "2026-10-20")], [pay("m", 10000, "2026-10-10")]);
  assert.equal(view(monthly, "m").renewalCount, 1);
  assert.equal(view(monthly, "m").nextOpenDueDate, "2026-11-10");
  assert.deepEqual(monthly.chargeOrder, ["y", "m"]);
  assert.deepEqual(tab(monthly, "Em atraso"), []);
});

test("C7. quinzenal (5/20, 10/25, 15/30, fim de mês) e diário: a data é a do motor, sem regra paralela", () => {
  const ops = [biweekly("q05", "2026-10-05"), biweekly("q10", "2026-09-10"), biweekly("q30", "2026-09-30"), biweekly("q15", "2026-09-15"), biweekly("q01", "2026-10-01")];
  const pays = [pay("q05", 10000, "2026-10-05"), pay("q10", 10000, "2026-09-10"), pay("q30", 10000, "2026-09-30"), pay("q15", 10000, "2026-09-15"), pay("q01", 10000, "2026-10-01")];
  const portfolio = build(ops, pays);
  // Cada uma renovou uma vez; a próxima obrigação é o 2º vencimento da sequência do motor (dueDates).
  for (const operation of ops) assert.equal(view(portfolio, operation.id).nextOpenDueDate, dueDates("BIWEEKLY", operation.firstDueDate, 2)[1], operation.id);
  assert.equal(view(portfolio, "q05").nextOpenDueDate, "2026-10-20");
  assert.equal(view(portfolio, "q10").nextOpenDueDate, "2026-09-25");
  assert.equal(view(portfolio, "q30").nextOpenDueDate, "2026-10-15");
  assert.equal(view(portfolio, "q15").nextOpenDueDate, "2026-09-30");
  // 25/09 e 30/09 já passaram sem os juros do novo período: vencidas, primeiro; depois 15/10, 16/10 e 20/10.
  assert.deepEqual(portfolio.chargeOrder, ["q10", "q15", "q30", "q01", "q05"]);
  assert.deepEqual(tab(portfolio, "Em atraso"), ["q10", "q15"]);
  // Diário: primeiro dia ainda não totalmente pago (3 dias pagos + metade do 4º → 04/10).
  const daily = base("d", { frequency: "DAILY", installmentCount: 10, installmentCents: 11000, firstDueDate: "2026-10-01", dueDate: "2026-10-10", calculationRule: "DAILY_V1" });
  const withDaily = build([single("x", "2026-10-03"), daily], [pay("d", 38000, "2026-10-03")]);
  assert.equal(view(withDaily, "d").nextOpenDueDate, "2026-10-04");
  assert.deepEqual(tab(withDaily, "Em atraso"), ["x", "d"]);
});

test("C8. quitada não é cobrança aberta; aberta sem saldo fica só no fim de Em aberto", () => {
  const ops = [
    single("quitada", "2026-10-13", { status: "PAID", settledAt: "2026-10-01" }),
    single("semSaldo", "2026-10-13"),
    single("a", "2026-10-20"),
    single("b", "2026-09-20"),
  ];
  const portfolio = build(ops, [pay("quitada", 110000, "2026-10-01"), pay("semSaldo", 110000, "2026-10-02")]);
  assert.equal(view(portfolio, "semSaldo").nextOpenDueDate, null);
  assert.ok(!portfolio.chargeOrder.includes("quitada"));
  assert.deepEqual(portfolio.chargeOrder, ["b", "a", "semSaldo"]);
  for (const name of ["Hoje", "Amanhã", "Próximas", "Em atraso"]) {
    assert.ok(!tab(portfolio, name).includes("quitada"), name);
    assert.ok(!tab(portfolio, name).includes("semSaldo"), name);
  }
  // Os contadores do menu/dashboard não contam a sem saldo como "vence hoje".
  assert.equal(portfolio.summary.counts.dueToday, 0);
  assert.equal(portfolio.summary.counts.overdue, 1);
});

test("C9. cinco abas: cada uma com o seu filtro, sem duplicar dentro da aba, contadores iguais às listas", () => {
  const ops = [
    single("v1", "2026-09-01"), single("v2", "2026-10-12"), single("h1", TODAY), single("h2", TODAY, { clientName: "Ana" }),
    single("a1", "2026-10-14"), single("p3", "2026-10-16"), single("p7", "2026-10-20"), single("f8", "2026-10-21"), single("f60", "2026-12-12"),
    installment("par", "2026-09-13", 4), single("pg", "2026-10-01", { status: "PAID", settledAt: "2026-10-01" }),
  ];
  const portfolio = build(ops, [pay("par", 100000, "2026-09-13"), pay("pg", 110000, "2026-10-01")]);
  const open = portfolio.operations.filter((operation) => operation.status === "OPEN");
  assert.deepEqual(portfolio.chargeOrder, ["v1", "v2", "h2", "h1", "par", "a1", "p3", "p7", "f8", "f60"]);
  assert.equal(portfolio.chargeOrder.length, open.length);
  assert.deepEqual(tab(portfolio, "Em atraso"), ["v1", "v2"]);
  assert.deepEqual(tab(portfolio, "Hoje"), ["h2", "h1", "par"]);
  assert.deepEqual(tab(portfolio, "Amanhã"), ["a1"]);
  assert.deepEqual(tab(portfolio, "Próximas"), ["a1", "p3", "p7"]);
  for (const name of ["Hoje", "Amanhã", "Próximas", "Em atraso"]) {
    const ids = tab(portfolio, name);
    assert.equal(new Set(ids).size, ids.length, `${name} sem duplicata`);
    // Cada aba segue a mesma ordem relativa da aba Em aberto.
    assert.deepEqual(ids, portfolio.chargeOrder.filter((id) => ids.includes(id)), `${name} na ordem de cobrança`);
  }
  assert.equal(portfolio.summary.counts.overdue, tab(portfolio, "Em atraso").length);
  assert.equal(portfolio.summary.counts.dueToday, tab(portfolio, "Hoje").length);
  assert.equal(new Set(portfolio.chargeOrder).size, portfolio.chargeOrder.length);
});

test("C10. mesmo vencimento: desempate pelo nome do cliente e pelo id, igual em qualquer ordem de entrada", () => {
  const ops = [
    single("op_b", "2026-10-20", { clientName: "Bruno" }), single("op_a2", "2026-10-20", { clientName: "Álvaro" }),
    single("op_a1", "2026-10-20", { clientName: "Álvaro" }), single("op_c", "2026-10-20", { clientName: "carla" }),
  ];
  const expected = ["op_a1", "op_a2", "op_b", "op_c"];
  for (const input of [ops, [...ops].reverse(), [ops[2], ops[0], ops[3], ops[1]]]) {
    const portfolio = build(input);
    assert.deepEqual(portfolio.chargeOrder, expected);
    assert.deepEqual(tab(portfolio, "Próximas"), expected);
  }
  assert.ok(compareCharges({ id: "a", clientName: "Z", nextOpenDueDate: "2099-01-01" }, { id: "b", clientName: "A", nextOpenDueDate: null }) < 0);
});

test("C11. depois de um pagamento a lista se reordena sozinha (mesma montagem do servidor)", () => {
  const ops = [single("m", "2026-10-05"), single("y", "2026-10-20"), installment("p", "2026-10-01", 3)];
  assert.deepEqual(build(ops).chargeOrder, ["p", "m", "y"]);
  const after = build(ops, [pay("p", 100000, "2026-10-01"), pay("m", 10000, "2026-10-05")]);
  assert.equal(view(after, "p").nextOpenDueDate, "2026-11-01");
  assert.equal(view(after, "m").nextOpenDueDate, "2026-11-05");
  assert.deepEqual(after.chargeOrder, ["y", "p", "m"]);
});

test("C12. ordenar não altera nenhum valor: operações, cards e cobranças iguais em qualquer ordem de entrada", () => {
  const ops = [single("a", "2026-09-30"), installment("p", "2026-09-13", 3), single("q", "2026-08-10", { status: "PAID", settledAt: "2026-08-10" }), single("m", "2026-10-10"), biweekly("b", "2026-10-05")];
  const pays = [pay("p", 140000, "2026-10-05"), pay("q", 110000, "2026-08-10"), pay("m", 10000, "2026-10-10"), pay("b", 10000, "2026-10-05")];
  const one = build(ops, pays), two = build([...ops].reverse(), [...pays].reverse());
  assert.deepEqual(one.summary, two.summary);
  assert.deepEqual(one.chargeOrder, two.chargeOrder);
  assert.deepEqual(one.charges, two.charges);
  for (const operation of one.operations) {
    const ledger = operationLedger(operation.ledgerTerms, pays.filter((payment) => payment.operationId === operation.id), TODAY);
    assert.equal(operation.nextDueDate, ledger.nextDueDate);
    assert.equal(operation.balanceCents, operation.status === "OPEN" ? ledger.balanceCents : 0);
    assert.deepEqual(view(two, operation.id), operation);
  }
  // A lista operations (usada nas outras telas) e a ordem de Operações não mudam.
  assert.deepEqual(one.operations.map((operation) => operation.id), ops.map((operation) => operation.id));
  assert.deepEqual(one.operationOrder, two.operationOrder);
});
