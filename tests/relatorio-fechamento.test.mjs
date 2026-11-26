import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addPaid, allocateClosing, buildClosingReport, closingFileName, effectiveRateBps, referencePeriod, UNASSIGNED_LABEL } from "../src/lib/managers/closing-report.ts";
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
  const lines = allocateClosing(27000, [contract("op1", "c1", "Cliente do Fernando", 200000, 3000, 4500, 60000)], new Map());
  assert.equal(lines.length, 1);
  assert.equal(lines[0].commissionCents, 27000);
  assert.equal(lines[0].principalCents, 200000);
});

test("fechamento do saldo inteiro: cada contrato leva exatamente a comissão gerada dele; contrato sem comissão fica de fora", () => {
  const contracts = [
    contract("op1", "c1", "Ana", 200000, 3000, 4500, 60000),   // 270,00
    contract("op2", "c2", "Bruno", 500000, 2000, 1000, 100000), // 100,00
    contract("op3", "c3", "Carla", 100000, 3000, 4500, 0),      // sem juros recebidos: não participa
  ];
  const lines = allocateClosing(37000, contracts, new Map());
  assert.deepEqual(lines.map((line) => [line.clientName, line.commissionCents]), [["Ana", 27000], ["Bruno", 10000]]);
  assert.equal(sum(lines), 37000);
});

test("comissão já paga em fechamentos anteriores não entra de novo; só o que falta de cada contrato", () => {
  const contracts = [contract("op1", "c1", "Ana", 200000, 3000, 4500, 120000), contract("op2", "c2", "Bruno", 500000, 2000, 1000, 100000)];
  const paid = addPaid(new Map(), [{ operationId: "op1", commissionCents: 27000 }, { operationId: "op2", commissionCents: 10000 }]);
  const lines = allocateClosing(27000, contracts, paid);
  assert.deepEqual(lines.map((line) => [line.operationId, line.commissionCents]), [["op1", 27000]]);
});

test("fechamento parcial: repartido em proporção ao que cada contrato tinha a pagar, em centavos exatos", () => {
  const contracts = [contract("op1", "c1", "Ana", 0, 3000, 1000, 100000), contract("op2", "c2", "Bruno", 0, 3000, 1000, 200000), contract("op3", "c3", "Carla", 0, 3000, 1000, 100001)];
  for (const amount of [1, 2, 3, 9999, 10001, 25000, 40000]) {
    const lines = allocateClosing(amount, contracts, new Map());
    assert.equal(sum(lines), amount, `soma ${amount}`);
    for (const line of lines) assert.ok(line.commissionCents <= commissionOf(line.interestReceivedCents, line.commissionBps));
  }
  const half = allocateClosing(20000, contracts, new Map());
  assert.deepEqual(half.map((line) => line.commissionCents), [5000, 10000, 5000]);
});

test("clientes marcados na conferência recebem primeiro; desmarcados só levam o que passar deles", () => {
  const contracts = [contract("op1", "c1", "Ana", 0, 3000, 1000, 100000), contract("op2", "c2", "Bruno", 0, 3000, 1000, 100000)];
  assert.deepEqual(allocateClosing(10000, contracts, new Map(), new Set(["c2"])).map((line) => [line.clientName, line.commissionCents]), [["Bruno", 10000]]);
  assert.deepEqual(allocateClosing(15000, contracts, new Map(), new Set(["c2"])).map((line) => [line.clientName, line.commissionCents]), [["Ana", 5000], ["Bruno", 10000]]);
});

test("total SEMPRE igual ao valor fechado: centavos de arredondamento vão para contratos; diferença maior vira linha à parte", () => {
  const contracts = [contract("op1", "c1", "Ana", 0, 3000, 3333, 1001), contract("op2", "c1", "Ana", 0, 3000, 3333, 1001)];
  // Saldo por cliente: 33,33% de 20,02 = 6,67; por contrato: 3,34 + 3,34 = 6,68. Ao contrário também (1 centavo de sobra).
  const rounding = allocateClosing(669, contracts, new Map());
  assert.equal(sum(rounding), 669);
  assert.ok(rounding.every((line) => line.operationId));
  const unexplained = allocateClosing(5000, contracts, new Map());
  assert.equal(sum(unexplained), 5000);
  assert.equal(unexplained.at(-1).clientName, UNASSIGNED_LABEL);
  assert.equal(unexplained.at(-1).operationId, null);
  // Propriedade: qualquer valor e qualquer combinação fecham no centavo.
  let seed = 7;
  const random = (max) => { seed = (seed * 48271) % 2147483647; return seed % max; };
  for (let round = 0; round < 300; round += 1) {
    const many = Array.from({ length: 1 + random(8) }, (_, index) => contract(`op${index}`, `c${random(3)}`, `Cliente ${index}`, random(900000), random(5000), random(10001), random(500000)));
    const amount = 1 + random(200000);
    assert.equal(sum(allocateClosing(amount, many, new Map(), random(2) ? new Set(["c1"]) : null)), amount);
  }
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
  assert.deepEqual(report.totals, { commissionCents: 27000, debitCents: 2000, creditCents: 500, finalCents: 25500, clients: 1, contracts: 1 });
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
    "Total pago ao gerente", "Valores históricos gravados no momento do fechamento", "Observação do fechamento: Pago por Pix", "Página 1 de 1",
  ]) assert.ok(text.includes(expected), `PDF sem "${expected}"\n${text}`);
});

test("PDF de fechamento antigo avisa que foi reconstituído; muitos contratos quebram página com cabeçalho repetido", async () => {
  const lines = Array.from({ length: 60 }, (_, index) => ({ ...contract(`op${index}`, `c${index}`, `Cliente ${String(index).padStart(2, "0")}`, 100000, 3000, 1000, 30000), commissionCents: 3000 }));
  const report = buildClosingReport({ tenantName: "Carteira", managerName: "Gerente Antigo", period, payout: payout(180000), lines, adjustments: [], source: "RECONSTRUCTED", generatedAt: new Date() });
  const pages = pdfPages(await renderClosingPdf(report, FONTS));
  assert.ok(pages.length >= 2);
  assert.ok(pages.slice(1).every((page) => page.includes("Gerente Antigo (continuação)") && page.includes("Valor emprestado")));
  const text = pages.join("\n").replace(/\u00a0/g, " ");
  assert.ok(text.includes("reconstituída com os recebimentos registrados até a data do fechamento"));
  assert.ok(text.includes("Cliente 59") && text.includes("60 contratos Total R$ 60.000,00") && text.includes("R$ 1.800,00"));
  assert.ok(text.includes(`Página ${pages.length} de ${pages.length}`));
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
