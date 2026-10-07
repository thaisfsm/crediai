import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio, compareByNextOpenDue } from "../src/lib/finance/portfolio.ts";
import { operationLedger } from "../src/lib/finance/rules.ts";

// Ordem da lista "Operações da carteira": pela próxima obrigação em aberto (a mais antiga primeiro), quitadas no fim.
const TODAY = "2026-10-06";
const base = (id, extra) => ({
  id, clientId: "c", clientName: `Cliente ${id}`, principalCents: 100000, interestRateBps: 1000, interestCents: 10000, totalCents: 110000,
  loanDate: "2026-09-01", status: "OPEN", settledAt: null, calculationRule: "RATE_PER_OPERATION_SINGLE_PAYMENT_V1", createdAt: "2026-09-01T10:00:00Z", ...extra,
});
const single = (id, due, extra = {}) => base(id, { dueDate: due, firstDueDate: due, ...extra });
// Parcelado com parcelas mensais de R$ 1.000 a partir de firstDue.
const installment = (id, firstDue, count, extra = {}) => base(id, {
  modality: "INSTALLMENT", installmentCount: count, installmentCents: 100000, principalCents: count * 90000, interestCents: count * 10000, totalCents: count * 100000,
  firstDueDate: firstDue, dueDate: firstDue, calculationRule: "FIXED_MONTHLY_INSTALLMENTS_V1", ...extra,
});
let seq = 0;
const pay = (operationId, amountCents, paidAt) => ({ id: `p${++seq}`, operationId, clientName: "x", amountCents, paidAt, notes: null, createdAt: `${paidAt}T12:00:${String(seq % 60).padStart(2, "0")}Z` });
const build = (operations, payments = []) => buildPortfolio({ initialCapitalCents: 10_000_000, hasWallet: true, operations, payments, today: TODAY });
const order = (operations, payments = []) => {
  const portfolio = build(operations, payments);
  return portfolio.operationOrder;
};
const view = (portfolio, id) => portfolio.operations.find((operation) => operation.id === id);

test("O1. vencimentos diferentes: 10/10 antes de 12/10 antes de 20/10", () => {
  assert.deepEqual(order([single("c", "2026-10-20"), single("a", "2026-10-10"), single("b", "2026-10-12")]), ["a", "b", "c"]);
});

test("O2. atrasada (30/09) vem antes das que ainda vão vencer, sem mudar a situação", () => {
  const ops = [single("b", "2026-10-05"), single("d", "2026-10-12"), single("a", "2026-09-30"), single("c", "2026-10-10")];
  const portfolio = build(ops);
  assert.deepEqual(portfolio.operationOrder, ["a", "b", "c", "d"]);
  assert.equal(view(portfolio, "a").state, "OVERDUE");
  assert.equal(view(portfolio, "d").state, "ACTIVE");
});

test("O3. parcelado 10/10, 10/11, 10/12 com a 1ª em aberto: ordena por 10/10, não pela última parcela", () => {
  const portfolio = build([single("z", "2026-10-20"), installment("p", "2026-10-10", 3)]);
  assert.equal(view(portfolio, "p").nextOpenDueDate, "2026-10-10");
  assert.equal(view(portfolio, "p").installments.at(-1).dueDate, "2026-12-10");
  assert.deepEqual(portfolio.operationOrder, ["p", "z"]);
});

test("O4. depois de quitar a parcela de 10/10, a mesma operação passa a ordenar por 10/11", () => {
  const portfolio = build([single("z", "2026-10-20"), installment("p", "2026-10-10", 3)], [pay("p", 100000, "2026-10-05")]);
  assert.equal(view(portfolio, "p").nextOpenDueDate, "2026-11-10");
  assert.deepEqual(portfolio.operationOrder, ["z", "p"]);
});

test("O5. pagamento parcial: parcela de R$ 1.000 com R$ 500 pagos continua em aberto (ordena por 10/10)", () => {
  const portfolio = build([single("z", "2026-10-20"), installment("p", "2026-10-10", 3)], [pay("p", 50000, "2026-10-05")]);
  const p = view(portfolio, "p");
  assert.equal(p.nextInstallment.state, "PARTIAL");
  assert.equal(p.nextInstallment.remainingCents, 50000);
  assert.equal(p.nextOpenDueDate, "2026-10-10");
  assert.deepEqual(portfolio.operationOrder, ["p", "z"]);
  // Pagamento único com juros pagos só em parte: o período continua em aberto, mesmo vencimento.
  const partial = build([single("s", "2026-10-10")], [pay("s", 4000, "2026-10-01")]);
  assert.equal(view(partial, "s").nextOpenDueDate, "2026-10-10");
});

test("O6. mesma próxima data: desempate determinístico (criação, depois id), qualquer que seja a ordem de entrada", () => {
  const ops = [
    single("op_b", "2026-10-10", { createdAt: "2026-09-02T10:00:00Z" }),
    single("op_c", "2026-10-10", { createdAt: "2026-09-01T10:00:00Z" }),
    single("op_a", "2026-10-10", { createdAt: "2026-09-02T10:00:00Z" }),
  ];
  const expected = ["op_c", "op_a", "op_b"];
  assert.deepEqual(order(ops), expected);
  assert.deepEqual(order([...ops].reverse()), expected);
  assert.deepEqual(order([ops[1], ops[2], ops[0]]), expected);
});

test("O7. quitada fica depois de todas as que têm obrigação em aberto, sem data inventada", () => {
  const ops = [
    single("q1", "2026-08-10", { status: "PAID", settledAt: "2026-08-10", loanDate: "2026-07-10" }),
    single("a", "2026-12-31"),
    single("q2", "2026-09-10", { status: "PAID", settledAt: "2026-09-10", loanDate: "2026-08-10" }),
    single("b", "2026-09-15"),
  ];
  const portfolio = build(ops, [pay("q1", 110000, "2026-08-10"), pay("q2", 110000, "2026-09-10")]);
  assert.equal(view(portfolio, "q1").nextOpenDueDate, null);
  assert.equal(view(portfolio, "q1").state, "PAID");
  // Abertas pela data; quitadas no fim, da mais recente para a mais antiga.
  assert.deepEqual(portfolio.operationOrder, ["b", "a", "q2", "q1"]);
});

test("O8. mensal: usa o período em aberto que o motor já calcula (juros pagos → período seguinte)", () => {
  const portfolio = build([single("m", "2026-09-10"), single("x", "2026-10-08")], [pay("m", 10000, "2026-09-10")]);
  const m = view(portfolio, "m");
  assert.equal(m.renewalCount, 1);
  assert.equal(m.nextOpenDueDate, "2026-10-10");
  assert.equal(m.nextOpenDueDate, m.nextDueDate);
  assert.deepEqual(portfolio.operationOrder, ["x", "m"]);
});

test("O9. quinzenal: próxima quinzena em aberto do motor (vencida sem pagamento fica com a data vencida)", () => {
  const ops = [single("q", "2026-09-20", { frequency: "BIWEEKLY", calculationRule: "BIWEEKLY_INTEREST_V1" }), single("w", "2026-09-25", { frequency: "BIWEEKLY" })];
  const late = build(ops);
  assert.equal(view(late, "q").nextOpenDueDate, "2026-09-20");
  assert.deepEqual(late.operationOrder, ["q", "w"]);
  const renewed = build(ops, [pay("q", 10000, "2026-09-20")]);
  const q = view(renewed, "q");
  assert.equal(q.nextOpenDueDate, q.nextDueDate);
  assert.ok(q.nextOpenDueDate > "2026-09-20");
  assert.deepEqual(renewed.operationOrder, ["w", "q"]);
});

test("O10. diário: primeiro dia ainda não totalmente pago", () => {
  const daily = base("d", { frequency: "DAILY", installmentCount: 10, installmentCents: 11000, firstDueDate: "2026-10-01", dueDate: "2026-10-10", calculationRule: "DAILY_V1" });
  // 3 dias pagos e meio do 4º: o 4º dia (04/10) segue em aberto.
  const portfolio = build([single("x", "2026-10-03"), daily], [pay("d", 33000 + 5000, "2026-10-03")]);
  assert.equal(view(portfolio, "d").nextOpenDueDate, "2026-10-04");
  assert.deepEqual(portfolio.operationOrder, ["x", "d"]);
});

test("O11. exemplo completo: ordem crescente da próxima obrigação em aberto, quitada no fim", () => {
  const ops = [
    single("op6", "2026-09-01", { status: "PAID", settledAt: "2026-09-01" }),
    installment("op5", "2026-10-05", 3),
    installment("op4", "2026-10-10", 3, { createdAt: "2026-09-02T10:00:00Z" }),
    single("op3", "2026-10-10"),
    single("op2", "2026-10-05"),
    single("op1", "2026-09-30"),
  ];
  const portfolio = build(ops, [pay("op6", 110000, "2026-09-01"), pay("op5", 100000, "2026-10-05")]);
  assert.equal(view(portfolio, "op5").nextOpenDueDate, "2026-11-05");
  assert.deepEqual(portfolio.operationOrder, ["op1", "op2", "op3", "op4", "op5", "op6"]);
});

test("O12. ordenar não altera nenhuma regra nem valor: vencimento exibido, situação, saldos e cards iguais", () => {
  const ops = [single("a", "2026-09-30"), installment("p", "2026-10-10", 3), single("q", "2026-08-10", { status: "PAID", settledAt: "2026-08-10" }), single("m", "2026-09-10")];
  const pays = [pay("p", 50000, "2026-10-05"), pay("q", 110000, "2026-08-10"), pay("m", 10000, "2026-09-10")];
  const one = build(ops, pays), two = build([...ops].reverse(), [...pays].reverse());
  assert.deepEqual(one.summary, two.summary);
  assert.deepEqual(one.operationOrder, two.operationOrder);
  for (const operation of one.operations) {
    // A coluna Vencimento continua sendo o nextDueDate do extrato; nada foi recalculado fora do motor.
    const ledger = operationLedger(operation.ledgerTerms, pays.filter((payment) => payment.operationId === operation.id), TODAY);
    assert.equal(operation.nextDueDate, ledger.nextDueDate);
    assert.equal(operation.balanceCents, operation.status === "OPEN" ? ledger.balanceCents : 0);
    assert.deepEqual(view(two, operation.id), operation);
  }
  // A lista operations (usada nas outras telas) mantém a ordem que já tinha.
  assert.deepEqual(one.operations.map((operation) => operation.id), ops.map((operation) => operation.id));
});

test("O13. comparador puro: sem obrigação em aberto sempre depois", () => {
  const open = { id: "a", createdAt: "2026-01-01", loanDate: "2026-01-01", nextOpenDueDate: "2099-12-31" };
  const paid = { id: "b", createdAt: "2026-01-01", loanDate: "2026-01-01", nextOpenDueDate: null };
  assert.ok(compareByNextOpenDue(open, paid) < 0);
  assert.ok(compareByNextOpenDue(paid, open) > 0);
});
