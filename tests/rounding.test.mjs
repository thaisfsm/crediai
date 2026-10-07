import { test } from "node:test";
import assert from "node:assert/strict";
import { amortizedInterestPaid, calculateDaily, calculateInstallments, operationLedger } from "../src/lib/finance/rules.ts";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";

// Auditoria de arredondamento: tudo em centavos inteiros, sem float sobrando, e sem centavos "fantasmas".
const installment = (principalCents, interestCents, count, installmentCents) => ({
  modality: "INSTALLMENT", frequency: "MONTHLY", principalCents, interestRateBps: 0, interestCents, firstDueDate: "2026-01-10",
  installmentCount: count, installmentCents, renewals: [],
});
const payments = (amounts) => amounts.map((amountCents, index) => ({ id: `p${index}`, amountCents, paidAt: `2026-01-${String(10 + (index % 18)).padStart(2, "0")}`, createdAt: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z` }));
const isCents = (value) => Number.isInteger(value);

test("R1. produção: R$ 5.000 em 6 × R$ 1.166 (juros R$ 1.996), 5 parcelas pagas → juros pagos R$ 1.663,33, sem acumular R$ 0,02", () => {
  const terms = installment(500000, 199600, 6, 116600);
  const ledger = operationLedger(terms, payments(Array(5).fill(116600)), "2026-10-06");
  // Exato: 5 × 1.166 × 1.996 / 6.996 = R$ 1.663,333… → R$ 1.663,33. A regra antiga somava 5 × R$ 332,67 = R$ 1.663,35.
  assert.equal(ledger.interestPaidCents, 166333);
  assert.equal(ledger.principalPaidCents, 416667);
  assert.equal(ledger.interestPaidCents + ledger.principalPaidCents, 5 * 116600);
  assert.equal(ledger.principalRemainingCents, 83333);
});

test("R2. cada pagamento: juros + principal = valor pago, em centavos inteiros", () => {
  const terms = installment(1234567, 765433, 7, 285714);
  const ledger = operationLedger(terms, payments([285714, 285714, 100001, 185713, 285714]), "2026-10-06");
  for (const item of ledger.items) {
    assert.ok(isCents(item.interestCents) && isCents(item.principalCents));
    assert.equal(item.interestCents + item.principalCents, item.amountCents);
    assert.ok(item.interestCents >= 0 && item.principalCents >= 0);
  }
});

test("R3. o arredondamento nunca se acumula: juros pagos ficam a no máximo meio centavo da proporção exata", () => {
  // Contrato longo (360 parcelas) com proporção que nunca dá centavo exato: a regra antiga chegaria a ~R$ 1,20 de desvio.
  const terms = installment(1000000, 333333, 360, 3703);
  const amounts = Array(359).fill(3703);
  let paid = 0;
  for (let k = 1; k <= amounts.length; k += 1) {
    paid += 3703;
    const exact = (paid * 333333) / 1333333;
    assert.ok(Math.abs(amortizedInterestPaid(paid, terms) - exact) <= 0.5, `parcela ${k}`);
  }
  const ledger = operationLedger(terms, payments(amounts), "2027-01-01");
  assert.ok(Math.abs(ledger.interestPaidCents - (paid * 333333) / 1333333) <= 0.5);
});

test("R4. quitação fecha exatamente: juros pagos = juros do contrato, principal pago = principal, saldo zero", () => {
  for (const [principal, interest, count, base] of [[500000, 199600, 6, 116600], [200000, 160000, 9, 40000], [200000, 85000, 3, 95000], [1000000, 333333, 7, 190476]]) {
    const total = principal + interest;
    const amounts = Array(count - 1).fill(base).concat(total - base * (count - 1));
    const ledger = operationLedger(installment(principal, interest, count, base), payments(amounts), "2027-01-01");
    assert.equal(ledger.balanceCents, 0);
    assert.equal(ledger.interestPaidCents, interest);
    assert.equal(ledger.principalPaidCents, principal);
    assert.equal(ledger.interestPaidCents + ledger.principalPaidCents, total);
    assert.equal(ledger.items.at(-1).kind, "SETTLEMENT");
  }
});

test("R5. diário: o último pagamento ajusta os centavos e a soma fecha o total (R$ 1.000 a 10% em 7 dias)", () => {
  const plan = calculateDaily({ principalCents: 100000, interestRateBps: 1000, days: 7, loanDate: "2026-10-01" });
  assert.equal(plan.totalCents, 110000);
  assert.equal(plan.installmentCents, 15714);
  assert.equal(plan.lastInstallmentCents, 15716);
  assert.equal(plan.installmentCents * 6 + plan.lastInstallmentCents, plan.totalCents);
  const terms = { modality: "SINGLE", frequency: "DAILY", principalCents: 100000, interestRateBps: 1000, interestCents: plan.interestCents, firstDueDate: plan.firstDueDate, installmentCount: 7, installmentCents: plan.installmentCents, renewals: [] };
  const ledger = operationLedger(terms, payments([...Array(6).fill(15714), 15716]), "2026-10-20");
  assert.equal(ledger.balanceCents, 0);
  assert.equal(ledger.schedule.at(-1).amountCents, 15716);
  assert.equal(ledger.interestPaidCents, 10000);
  assert.equal(ledger.principalPaidCents, 100000);
});

test("R6. parcelado: principal + juros = total contratado (sem float)", () => {
  for (const [principal, installmentCents, count] of [[500000, 116600, 6], [1000000, 160000, 10], [123456, 20000, 7]]) {
    const result = calculateInstallments({ principalCents: principal, installmentCents, count });
    assert.ok(isCents(result.totalCents) && isCents(result.interestCents));
    assert.equal(principal + result.interestCents, result.totalCents);
    assert.equal(result.totalCents, installmentCents * count);
  }
});

test("R7. carteira: capital emprestado + juros recebidos batem com o que foi pago (nenhum centavo criado ou perdido)", () => {
  const operations = [
    { id: "op_a", clientId: "c", clientName: "A", principalCents: 500000, interestRateBps: 1053, interestCents: 199600, totalCents: 699600, loanDate: "2026-01-01", dueDate: "2026-07-10", status: "OPEN", settledAt: null, calculationRule: "FIXED_MONTHLY_INSTALLMENTS_V1", createdAt: "2026-01-01T00:00:00Z", modality: "INSTALLMENT", installmentCount: 6, installmentCents: 116600, firstDueDate: "2026-02-10" },
    { id: "op_b", clientId: "c", clientName: "A", principalCents: 200000, interestRateBps: 1370, interestCents: 160000, totalCents: 360000, loanDate: "2026-01-01", dueDate: "2026-10-10", status: "OPEN", settledAt: null, calculationRule: "FIXED_MONTHLY_INSTALLMENTS_V1", createdAt: "2026-01-01T00:00:00Z", modality: "INSTALLMENT", installmentCount: 9, installmentCents: 40000, firstDueDate: "2026-02-10" },
  ];
  const pays = [...Array(5).fill(["op_a", 116600]), ...Array(3).fill(["op_b", 40000])].map(([operationId, amountCents], index) => ({ id: `p${index}`, operationId, clientName: "A", amountCents, paidAt: "2026-05-10", notes: null, createdAt: `2026-05-10T00:00:${String(index).padStart(2, "0")}Z` }));
  const { summary } = buildPortfolio({ initialCapitalCents: 1000000, hasWallet: true, operations, payments: pays, today: "2026-10-06" });
  const paid = pays.reduce((total, payment) => total + payment.amountCents, 0);
  assert.equal(summary.receivedInterestCents + summary.receivedPrincipalCents, paid);
  assert.equal(summary.lentCents + summary.receivedPrincipalCents, 700000);
  // R$ 1.663,33 + R$ 533,33 (antes: R$ 1.663,35 + R$ 533,34 = R$ 0,03 a mais de juros e a menos de principal).
  assert.equal(summary.receivedInterestCents, 166333 + 53333);
  assert.equal(summary.availableCents, 1000000 - 700000 + paid);
});
