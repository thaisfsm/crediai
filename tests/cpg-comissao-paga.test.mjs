import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPortfolio } from "../src/lib/finance/portfolio.ts";
import { allocatePayout, contractReceipts, contractsWithStatus, netPaidByPayment, receiptsWithStatus, reversibleByRow } from "../src/lib/managers/commission-paid.ts";
import { buildClosingReport, linesFromCommissionPaid, unregisteredLine, UNASSIGNED_LABEL } from "../src/lib/managers/closing-report.ts";

// Controle CPG (comissão paga por recebimento de juros). Os três contratos abaixo têm os MESMOS valores, datas e pagamentos dos contratos
// que compuseram o fechamento de 19/11/2026 da gerente (nomes de teste): o extrato real do CrediAI (buildPortfolio) divide cada pagamento
// em juros e principal e a comissão sai de cada recebimento.
const RULE = "RATE_PER_OPERATION_SINGLE_PAYMENT_V1";
const operation = (id, principalCents, rateBps, loanDate, dueDate, extra = {}) => ({
  id, clientId: `c_${id}`, clientName: `Cliente ${id}`, principalCents, interestRateBps: rateBps, interestCents: Math.round(principalCents * rateBps / 10000),
  totalCents: principalCents + Math.round(principalCents * rateBps / 10000), loanDate, dueDate, firstDueDate: dueDate, status: "OPEN", settledAt: null, calculationRule: RULE,
  createdAt: `${loanDate}T12:00:00Z`, modality: "SINGLE", frequency: "MONTHLY", paymentOrder: "INTEREST_FIRST", ...extra,
});
const payment = (id, operationId, amountCents, paidAt, extra = {}) => ({ id, operationId, clientName: "x", amountCents, paidAt, notes: null, createdAt: `${paidAt}T15:00:00Z`, ...extra });
const portfolio = buildPortfolio({
  initialCapitalCents: 0, hasWallet: true, today: "2026-11-19",
  operations: [
    operation("aline", 100000, 3000, "2026-10-13", "2026-12-13", { firstDueDate: "2026-11-13",
      renewals: [{ id: "ren_a", paymentId: "pay_aline", periodNumber: 2, previousDueDate: "2026-11-13", newDueDate: "2026-12-13", principalBaseCents: 100000, interestCents: 30000, createdAt: "2026-11-14T15:00:00Z" }] }),
    operation("bruna", 150000, 3000, "2026-10-09", "2026-11-09", { status: "PAID", settledAt: "2026-11-09" }),
    operation("thaina", 50000, 1500, "2026-10-13", "2026-11-13", { status: "PAID", settledAt: "2026-11-16" }),
    // Contrato de outro cliente com juros recebidos (fica pendente: não entrou no fechamento).
    operation("sabrina", 50000, 3000, "2026-10-13", "2026-11-13", { status: "PAID", settledAt: "2026-11-10" }),
  ],
  payments: [
    payment("pay_aline", "aline", 30000, "2026-11-14", { mode: "INTEREST_ONLY_RENEWAL", allocationOrder: "INTEREST_FIRST", period: 1 }),
    payment("pay_bruna", "bruna", 195000, "2026-11-09", { mode: "FULL_SETTLEMENT", allocationOrder: "INTEREST_FIRST" }),
    payment("pay_thaina1", "thaina", 33000, "2026-10-21"),
    payment("pay_thaina2", "thaina", 28175, "2026-11-16", { mode: "FULL_SETTLEMENT", allocationOrder: "INTEREST_FIRST" }),
    payment("pay_sabrina", "sabrina", 65000, "2026-11-10", { mode: "FULL_SETTLEMENT", allocationOrder: "INTEREST_FIRST" }),
  ],
});
const view = (id) => portfolio.operations.find((item) => item.id === id);
const receiptsOf = (id, bps = 5000) => {
  const op = view(id);
  return contractReceipts({ operationId: op.id, clientId: op.clientId, clientName: op.clientName, operationCode: op.code, loanDate: op.loanDate, principalCents: op.principalCents,
    interestRateBps: op.interestRateBps, commissionBps: bps, interestPaidCents: op.interestPaidCents }, op.payments.map((item) => ({ id: item.id, paidAt: item.paidAt, createdAt: item.createdAt, interestCents: item.interestCents })));
};
const all = () => ["aline", "bruna", "thaina", "sabrina"].flatMap((id) => receiptsOf(id));
let seq = 0;
const paidRow = (receipt, cents, payoutId = "mgp_1911", extra = {}) => ({
  id: `cpg_${++seq}`, payoutId, kind: "PAID", reversesId: null, paymentId: receipt.paymentId, operationId: receipt.operationId, clientId: receipt.clientId, clientName: receipt.clientName,
  operationCode: receipt.operationCode, loanDate: receipt.loanDate, principalCents: receipt.principalCents, interestRateBps: receipt.interestRateBps, commissionBps: receipt.commissionBps,
  receiptPaidOn: receipt.paidOn, interestCents: receipt.interestCents, commissionDueCents: receipt.commissionDueCents, commissionCents: cents, source: "HISTORICAL", reason: "teste", createdAt: "2026-11-27T20:00:00Z", ...extra,
});

test("juros recebidos de cada recebimento vêm do extrato: Aline 300,00; Bruna 450,00; Thaina 75,00 + 36,75 = 111,75", () => {
  assert.deepEqual(receiptsOf("aline").map((r) => [r.paymentId, r.interestCents, r.commissionDueCents]), [["pay_aline", 30000, 15000]]);
  assert.deepEqual(receiptsOf("bruna").map((r) => [r.paymentId, r.interestCents, r.commissionDueCents]), [["pay_bruna", 45000, 22500]]);
  const thaina = receiptsOf("thaina");
  assert.equal(thaina.reduce((t, r) => t + r.interestCents, 0), 11175);
  // Acumulado arredondado: 37,50 + 18,38 = 55,88 (a comissão do contrato inteiro).
  assert.equal(thaina.reduce((t, r) => t + r.commissionDueCents, 0), 5588);
  assert.equal(view("thaina").interestPaidCents, 11175);
  assert.deepEqual(thaina.map((r) => [r.paymentId, r.interestCents, r.commissionDueCents]), [["pay_thaina1", 7500, 3750], ["pay_thaina2", 3675, 1838]]);
});

test("fechamento histórico de 19/11: Aline 150,00 + Bruna 225,00 + Thaina 55,88 = 430,88; PDF só com os 3 contratos, sem rateio", () => {
  const receipts = [...receiptsOf("aline"), ...receiptsOf("bruna"), ...receiptsOf("thaina")];
  const rows = receipts.map((receipt) => paidRow(receipt, receipt.commissionDueCents));
  const lines = linesFromCommissionPaid(rows, "mgp_1911");
  assert.deepEqual(lines.map((line) => [line.operationId, line.interestReceivedCents, line.commissionBps, line.commissionCents]),
    [["aline", 30000, 5000, 15000], ["bruna", 45000, 5000, 22500], ["thaina", 11175, 5000, 5588]]);
  const report = buildClosingReport({ tenantName: "Carteira", managerName: "Gerente", period: { sequence: 1, total: 1, start: null, end: "2026-11-19", previousPaidOn: null },
    payout: { id: "mgp_1911", paidOn: "2026-11-19", createdAt: "2026-11-20T01:03:24Z", amountCents: 43088, debitCents: 0, creditCents: 0, notes: null },
    lines, adjustments: [], source: "CPG", historical: { recordedAt: "2026-11-27T20:00:00Z", reason: "confirmada pela responsável" }, generatedAt: new Date() });
  assert.equal(report.totals.commissionCents, 43088);
  assert.equal(report.totals.contracts, 3);
  // Juros × % = comissão em cada linha (nada de 30,62).
  for (const line of report.lines) assert.equal(line.commissionCents, Math.round(line.interestReceivedCents * line.commissionBps / 10000));
});

test("saldo: gerado 2.110,88 em 19/11 pede os 13 contratos; aqui os 4 de teste: pago o fechamento, pendente só a Sabrina", () => {
  const receipts = all();
  const rows = [...receiptsOf("aline"), ...receiptsOf("bruna"), ...receiptsOf("thaina")].map((receipt) => paidRow(receipt, receipt.commissionDueCents));
  const status = receiptsWithStatus(receipts, rows);
  const contracts = contractsWithStatus(status);
  assert.deepEqual(contracts.map((c) => [c.operationId, c.status, c.paidCents, c.pendingCents]),
    [["aline", "PAID", 15000, 0], ["bruna", "PAID", 22500, 0], ["sabrina", "PENDING", 0, 7500], ["thaina", "PAID", 5588, 0]]);
});

test("a mesma comissão não é paga duas vezes: o recebimento já pago não entra no próximo fechamento", () => {
  const rows = [...receiptsOf("aline")].map((receipt) => paidRow(receipt, receipt.commissionDueCents));
  const status = receiptsWithStatus(all(), rows);
  // Marcando só a Aline (toda paga): nada a pagar.
  assert.deepEqual(allocatePayout(15000, status, new Set(["aline"])), { ok: false, availableCents: 0 });
  // Sem marcar: só os pendentes dos outros.
  const result = allocatePayout(22500 + 5588 + 7500, status, null);
  assert.equal(result.ok, true);
  assert.ok(result.lines.every((line) => line.operationId !== "aline"));
  assert.equal(allocatePayout(22500 + 5588 + 7500 + 1, status, null).ok, false);
});

test("juros novos no mesmo contrato geram comissão nova; o contrato não fica travado", () => {
  const rows = receiptsOf("aline").map((receipt) => paidRow(receipt, receipt.commissionDueCents));
  // Novo recebimento de juros da Aline em 13/12 (R$ 300,00 de juros).
  const op = view("aline");
  const next = contractReceipts({ operationId: "aline", clientId: op.clientId, clientName: op.clientName, operationCode: op.code, loanDate: op.loanDate, principalCents: op.principalCents,
    interestRateBps: op.interestRateBps, commissionBps: 5000, interestPaidCents: 60000 }, [
    { id: "pay_aline", paidAt: "2026-11-14", createdAt: "2026-11-14T15:00:00Z", interestCents: 30000 },
    { id: "pay_aline2", paidAt: "2026-12-13", createdAt: "2026-12-13T15:00:00Z", interestCents: 30000 },
  ]);
  const status = receiptsWithStatus(next, rows);
  assert.deepEqual(status.map((r) => [r.paymentId, r.status, r.pendingCents]), [["pay_aline", "PAID", 0], ["pay_aline2", "PENDING", 15000]]);
  const result = allocatePayout(15000, status, new Set(["aline"]));
  assert.deepEqual(result.lines.map((line) => [line.paymentId, line.payCents]), [["pay_aline2", 15000]]);
  assert.equal(contractsWithStatus(status)[0].status, "PARTIAL");
});

test("pagamento parcial: os recebimentos mais antigos primeiro; o que sobra fica pendente só naquele recebimento", () => {
  const status = receiptsWithStatus(all(), []);
  const result = allocatePayout(10000, status, new Set(["thaina", "sabrina"]));
  // Thaina 21/10 (37,50) → Sabrina 10/11 (62,50 de 75,00).
  assert.deepEqual(result.lines.map((line) => [line.paymentId, line.payCents]), [["pay_thaina1", 3750], ["pay_sabrina", 6250]]);
  const after = receiptsWithStatus(all(), result.lines.map((line) => paidRow(line, line.payCents, "mgp_novo")));
  const sabrina = after.find((r) => r.paymentId === "pay_sabrina");
  assert.deepEqual([sabrina.status, sabrina.paidCents, sabrina.pendingCents], ["PARTIAL", 6250, 1250]);
});

test("estorno: devolve parte da linha, o recebimento volta a ficar pendente nesse valor e nunca passa do pago", () => {
  const [receipt] = receiptsOf("bruna");
  const paid = paidRow(receipt, 22500);
  const reversal = { ...paid, id: "cpg_rev", kind: "REVERSAL", reversesId: paid.id, commissionCents: 5000, reason: "devolvido" };
  assert.equal(netPaidByPayment([paid, reversal]).get("pay_bruna"), 17500);
  assert.equal(reversibleByRow([paid, reversal]).get(paid.id), 17500);
  const status = receiptsWithStatus([receipt], [paid, reversal]);
  assert.deepEqual([status[0].status, status[0].pendingCents], ["PARTIAL", 5000]);
  // Pode ser pago de novo depois do estorno (só os 50,00 estornados).
  assert.deepEqual(allocatePayout(5000, status, null).lines.map((line) => line.payCents), [5000]);
  assert.equal(allocatePayout(5001, status, null).ok, false);
});

test("fechamento sem composição registrada mostra o valor numa linha só, sem atribuir a contratos", () => {
  const line = unregisteredLine(43088);
  assert.equal(line.operationId, null);
  assert.equal(line.clientName, UNASSIGNED_LABEL);
  const report = buildClosingReport({ tenantName: "Carteira", managerName: "Gerente", period: { sequence: 1, total: 1, start: null, end: "2026-11-19", previousPaidOn: null },
    payout: { id: "mgp_x", paidOn: "2026-11-19", createdAt: "2026-11-20T01:03:24Z", amountCents: 43088, debitCents: 0, creditCents: 0, notes: null },
    lines: [line], adjustments: [], source: "UNREGISTERED", generatedAt: new Date() });
  assert.equal(report.totals.contracts, 0);
  assert.equal(report.totals.commissionCents, 43088);
});
