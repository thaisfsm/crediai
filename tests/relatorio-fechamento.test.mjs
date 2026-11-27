import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildClosingReport, closingFileName, effectiveRateBps, referencePeriod, unregisteredLine } from "../src/lib/managers/closing-report.ts";
import { renderClosingPdf } from "../src/lib/managers/closing-pdf.ts";
import { commissionOf } from "../src/lib/managers/commission.ts";
import { pdfPages, pdfText } from "./helpers/pdf-text.mjs";

const font = (style) => readFileSync(`src/lib/investors/fonts/LiberationSans-${style}.ttf`);
const FONTS = { regular: font("Regular"), bold: font("Bold"), italic: font("Italic") };
const contract = (id, clientId, clientName, principalCents, interestRateBps, commissionBps, interestReceivedCents, extra = {}) => ({
  operationId: id, clientId, clientName, operationCode: id.replace(/\D/g, "") || "1", loanDate: "2026-10-01", principalCents, interestRateBps, commissionBps, interestReceivedCents, ...extra,
});
const sum = (lines) => lines.reduce((total, line) => total + line.commissionCents, 0);
const period = { sequence: 1, total: 1, start: null, end: "2026-11-25", previousPaidOn: null };
const payout = (amountCents, extra = {}) => ({ id: "mgp_teste", paidOn: "2026-11-25", createdAt: "2026-11-25T15:00:00.000Z", amountCents, debitCents: 0, creditCents: 0, notes: null, ...extra });

test("exemplo do Fernando: R$ 2.000 a 30% com 45% de comissão = 13,50% efetivo e R$ 270 de comissão", () => {
  assert.equal(effectiveRateBps(3000, 4500), 1350);
  // Um período de juros recebido: R$ 600 (2.000 × 30%) × 45% = R$ 270 = 2.000 × 13,5%.
  assert.equal(commissionOf(60000, 4500), 27000);
  assert.equal(Math.round(200000 * effectiveRateBps(3000, 4500) / 10000), 27000);
});

test("período de referência: do dia seguinte ao fechamento anterior até a data; primeiro fechamento desde o início", () => {
  const payouts = [{ id: "b", paidOn: "2026-11-25", createdAt: "2026-11-25T10:00:00Z" }, { id: "a", paidOn: "2026-10-15", createdAt: "2026-10-15T10:00:00Z" }, { id: "c", paidOn: "2026-11-25", createdAt: "2026-11-25T12:00:00Z" }];
  assert.deepEqual(referencePeriod(payouts, "a"), { sequence: 1, total: 3, start: null, end: "2026-10-15", previousPaidOn: null });
  assert.deepEqual(referencePeriod(payouts, "b"), { sequence: 2, total: 3, start: "2026-10-16", end: "2026-11-25", previousPaidOn: "2026-10-15" });
  assert.deepEqual(referencePeriod(payouts, "c"), { sequence: 3, total: 3, start: "2026-11-25", end: "2026-11-25", previousPaidOn: "2026-11-25" });
  assert.equal(referencePeriod(payouts, "x"), null);
});

test("relatório recusa linhas que não somam o fechado ou lançamentos que não batem com os totais gravados", () => {
  const lines = [{ ...contract("op1", "c1", "Ana", 200000, 3000, 4500, 60000), commissionCents: 27000 }];
  const base = { tenantName: "Carteira", managerName: "Gabrielle", period, lines, adjustments: [], source: "SNAPSHOT", generatedAt: new Date("2026-11-26T12:00:00Z") };
  assert.throws(() => buildClosingReport({ ...base, payout: payout(27001) }), /linhas somam/);
  assert.throws(() => buildClosingReport({ ...base, payout: payout(27000, { debitCents: 100 }) }), /lançamentos/);
  const report = buildClosingReport({ ...base, payout: payout(27000, { debitCents: 2000, creditCents: 500 }), adjustments: [{ kind: "DEBIT", description: "Adiantamento", amountCents: 2000, entryDate: "2026-11-20" }, { kind: "CREDIT", description: "Bônus", amountCents: 500, entryDate: "2026-11-25" }] });
  assert.deepEqual(report.totals, { commissionCents: 27000, reversedCents: 0, debitCents: 2000, creditCents: 500, finalCents: 25500, clients: 1, contracts: 1 });
});

test("PDF: gerente, data, período, cada cliente e contrato com valor, taxa, percentuais, comissão e o total pago igual ao fechamento", async () => {
  const lines = [
    { ...contract("op1", "c1", "Ana Fictícia", 200000, 3000, 4500, 60000, { operationCode: "12" }), commissionCents: 27000 },
    { ...contract("op2", "c1", "Ana Fictícia", 100000, 2500, 4500, 25000, { operationCode: "15" }), commissionCents: 11250 },
    { ...contract("op3", "c2", "Bruno Fictício", 500000, 961, 1000, 48050, { operationCode: "20" }), commissionCents: 4805 },
  ];
  const report = buildClosingReport({
    tenantName: "Carteira de Teste · CrediAI", managerName: "Gabrielle Gerente", period: { sequence: 2, total: 3, start: "2026-10-16", end: "2026-11-25", previousPaidOn: "2026-10-15" },
    payout: payout(43055, { debitCents: 5000, creditCents: 1000, notes: "Pago por Pix" }), lines, source: "SNAPSHOT", generatedAt: new Date("2026-11-26T12:00:00Z"),
    adjustments: [{ kind: "DEBIT", description: "Adiantamento", amountCents: 5000, entryDate: "2026-11-20" }, { kind: "CREDIT", description: "Bônus de meta", amountCents: 1000, entryDate: "2026-11-25" }],
  });
  const bytes = await renderClosingPdf(report, FONTS, "Thaís Teste");
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  const text = pdfText(bytes);
  for (const expected of [
    "Relatório de Fechamento de Comissão", "Carteira de Teste · CrediAI", "Página: 1", "Usuário: Thaís Teste", "Gerente:", "Gabrielle Gerente", "Fechamento em 25/11/2026 · período 16/10/2026 a 25/11/2026",
    "#12 - Ana Fictícia", "R$ 2.000,00", "30,00%", "45,00%", "13,50%", "R$ 600,00", "R$ 270,00", "#15 - Ana Fictícia", "11,25%", "R$ 112,50",
    "#20 - Bruno Fictício", "9,61%", "10,00%", "0,961%", "R$ 48,05", "3 contratos Total R$ 8.000,00", "R$ 430,55",
    "Débito no fechamento · Adiantamento (20/11/2026)", "− R$ 50,00", "Crédito no fechamento · Bônus de meta (25/11/2026)", "+ R$ 10,00", "Valor pago a Gabrielle Gerente", "R$ 390,55",
    "Total pago ao gerente", "Valores históricos gravados no fechamento", "Observação do fechamento: Pago por Pix", "Página 1 de 1",
  ]) assert.ok(text.includes(expected), `PDF sem "${expected}"\n${text}`);
});

test("PDF de fechamento sem composição registrada: valor numa linha só, sem rateio; muitos contratos quebram página com cabeçalho repetido", async () => {
  const unregistered = buildClosingReport({ tenantName: "Carteira", managerName: "Gerente Antigo", period, payout: payout(43088), lines: [unregisteredLine(43088)], adjustments: [], source: "UNREGISTERED", generatedAt: new Date() });
  const single = pdfText(await renderClosingPdf(unregistered, FONTS)).replace(/\u00a0/g, " ");
  assert.ok(single.includes("Composição não registrada") && single.includes("R$ 430,88") && single.includes("0 contratos Total"));
  assert.ok(single.includes("sem composição confirmada: o valor gravado aparece sem divisão por contrato"));
  const lines = Array.from({ length: 60 }, (_, index) => ({ ...contract(`op${index}`, `c${index}`, `Cliente ${String(index).padStart(2, "0")}`, 100000, 3000, 1000, 30000), commissionCents: 3000 }));
  const report = buildClosingReport({ tenantName: "Carteira", managerName: "Gerente Antigo", period, payout: payout(180000), lines, adjustments: [], source: "SNAPSHOT", generatedAt: new Date() });
  const pages = pdfPages(await renderClosingPdf(report, FONTS));
  assert.ok(pages.length >= 2);
  assert.ok(pages.slice(1).every((page) => page.includes("Gerente Antigo (continuação)") && page.includes("Valor emprestado")));
  const text = pages.join("\n").replace(/\u00a0/g, " ");
  assert.ok(text.includes("Cliente 59") && text.includes("60 contratos Total R$ 60.000,00") && text.includes("R$ 1.800,00"));
  assert.ok(text.includes(`Página ${pages.length} de ${pages.length}`));
});

test("PDF da composição histórica (CPG): só os contratos pagos, nota de reconstrução confirmada e estorno ligado ao fechamento", async () => {
  const lines = [
    { ...contract("op_a", "c_a", "Aline Teste", 100000, 3000, 5000, 30000, { operationCode: "308E9F" }), commissionCents: 15000 },
    { ...contract("op_b", "c_b", "Bruna Teste", 150000, 3000, 5000, 45000, { operationCode: "DB4456" }), commissionCents: 22500 },
    { ...contract("op_t", "c_t", "Thaina Teste", 50000, 1500, 5000, 11175, { operationCode: "191ED6" }), commissionCents: 5588 },
  ];
  const report = buildClosingReport({ tenantName: "Carteira", managerName: "Gabrielle Teste", period: { ...period, end: "2026-11-19" }, payout: payout(43088, { paidOn: "2026-11-19" }), lines, adjustments: [],
    source: "CPG", historical: { recordedAt: "2026-11-27T20:00:00Z", reason: "composição confirmada pela responsável" }, generatedAt: new Date(),
    reversals: [{ clientName: "Bruna Teste", operationCode: "DB4456", receiptPaidOn: "2026-11-09", amountCents: 5000, reason: "devolvido", createdAt: "2026-11-28T10:00:00Z" }] });
  const text = pdfText(await renderClosingPdf(report, FONTS)).replace(/\u00a0/g, " ");
  for (const expected of ["#308E9F - Aline Teste", "R$ 300,00", "R$ 150,00", "#DB4456 - Bruna Teste", "R$ 450,00", "R$ 225,00", "#191ED6 - Thaina Teste", "R$ 111,75", "R$ 55,88",
    "3 contratos Total", "R$ 430,88", "reconstrução histórica confirmada pela responsável", "Estorno em 28/11/2026", "− R$ 50,00", "Comissão líquida após estornos", "R$ 380,88"]) assert.ok(text.includes(expected), `PDF sem "${expected}"\n${text}`);
  assert.ok(!text.includes("R$ 30,62"));
});

test("nome do arquivo sem acentos nem espaços", () => {
  assert.equal(closingFileName("Gabrielle Araújo", "2026-11-25", 3), "fechamento-comissao-gabrielle-araujo-2026-11-25-03.pdf");
});

test("PDF consolidado da data: um grupo por gerente com o total de cada um e o total geral (contratos e valores)", async () => {
  const make = (managerName, lines, extra = {}) => buildClosingReport({ tenantName: "Carteira", managerName, period, payout: payout(sum(lines), { id: `mgp_${managerName}`, ...extra.payout }), lines, adjustments: extra.adjustments ?? [], source: "SNAPSHOT", generatedAt: new Date() });
  const a = make("Gerente A", [{ ...contract("op1", "c1", "Ana", 200000, 3000, 4500, 60000), commissionCents: 27000 }]);
  const b = make("Gerente B", [{ ...contract("op2", "c2", "Bia", 100000, 2000, 1000, 20000), commissionCents: 2000 }, { ...contract("op3", "c3", "Caio", 300000, 2500, 3000, 75000), commissionCents: 22500 }],
    { payout: { debitCents: 1500 }, adjustments: [{ kind: "DEBIT", description: "Adiantamento", amountCents: 1500, entryDate: "2026-11-25" }] });
  const text = pdfText(await renderClosingPdf({ tenantName: "Carteira", generatedAt: new Date(), generatedBy: "Thaís", reports: [a, b], consolidatedDate: "2026-11-25" }, FONTS));
  for (const expected of ["Relatório Consolidado de Fechamento de Comissão", "Gerente A", "1 contrato Total R$ 2.000,00", "Valor pago a Gerente A", "Gerente B", "2 contratos Total R$ 4.000,00", "R$ 245,00", "Valor pago a Gerente B", "R$ 230,00",
    "Gerentes", "Contratos", "Comissão fechada", "R$ 515,00", "Total pago aos gerentes", "R$ 500,00"]) assert.ok(text.includes(expected), `PDF sem "${expected}"\n${text}`);
});
