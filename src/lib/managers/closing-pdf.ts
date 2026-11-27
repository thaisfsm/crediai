// Relatório do fechamento de comissão em PDF (A4 deitado, formato de lista como o "Relatório de Envio de Produção" do C.System), com
// pdf-lib, no próprio servidor: um grupo por gerente (uma linha por cliente/contrato e o total do grupo) e o total geral no fim.
// Mesma fonte embutida do contrato de investimento (Liberation Sans), então os acentos saem iguais em qualquer leitor e na impressão.
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatMoney, TIME_ZONE } from "@/lib/finance/format";
import type { ContractFontFiles } from "@/lib/investors/contract-pdf";
import { effectiveRateBps, type ClosingReport } from "./closing-report";

const PAGE = { width: 841.89, height: 595.28 };
const MARGIN = { left: 40, right: 40, top: 36, bottom: 50 };
const WIDTH = PAGE.width - MARGIN.left - MARGIN.right;
// Identidade do CrediAI: azul-marinho da barra lateral e o verde-água dos destaques.
const NAVY = rgb(12 / 255, 32 / 255, 44 / 255);
const TEAL = rgb(21 / 255, 155 / 255, 145 / 255);
const INK = rgb(18 / 255, 33 / 255, 45 / 255);
const MUTED = rgb(94 / 255, 110 / 255, 122 / 255);
const LINE = rgb(220 / 255, 226 / 255, 230 / 255);
const ZEBRA = rgb(245 / 255, 247 / 255, 248 / 255);
const WHITE = rgb(1, 1, 1);
const DANGER = rgb(198 / 255, 77 / 255, 77 / 255);

const dateBr = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "—");
const percent = (bps: number) => `${(bps / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 3 })}%`;
const dateTimeBr = (date: Date) => new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date).replace(",", "");

const GREEN = rgb(22 / 255, 136 / 255, 110 / 255);
const BLUE = rgb(24 / 255, 62 / 255, 140 / 255);
const HEAD_FILL = rgb(238 / 255, 242 / 255, 244 / 255);

type Column = { label: string; width: number; align: "left" | "right"; color?: ReturnType<typeof rgb> };
// Uma linha por cliente/contrato: "contrato - Cliente" e os valores do contrato com os percentuais gravados no fechamento.
const COLUMNS: Column[] = [
  { label: "Contrato - Cliente", width: 236.89, align: "left" }, { label: "Empréstimo", width: 60, align: "left" },
  { label: "Valor emprestado", width: 92, align: "right" }, { label: "Taxa de juros", width: 66, align: "right" }, { label: "% comissão", width: 64, align: "right" },
  { label: "% efetivo", width: 62, align: "right", color: GREEN }, { label: "Juros recebidos", width: 90, align: "right" }, { label: "Comissão", width: 90, align: "right", color: BLUE },
];

// Um ou mais fechamentos no mesmo PDF: o de UM fechamento tem um grupo (o gerente dele); o consolidado de uma data tem um grupo por
// gerente. Cada grupo fecha com o total dele; o total geral soma todos (contratos, valor emprestado, comissão, lançamentos e total pago).
export type ClosingPdfInput = { tenantName: string; generatedAt: Date; generatedBy?: string | null; reports: ClosingReport[]; consolidatedDate?: string };

export async function renderClosingPdf(input: ClosingReport | ClosingPdfInput, fontFiles: ContractFontFiles, generatedBy?: string | null) {
  const doc: ClosingPdfInput = "reports" in input ? input : { tenantName: input.tenantName, generatedAt: input.generatedAt, generatedBy, reports: [input] };
  const single = doc.reports.length === 1 && !doc.consolidatedDate ? doc.reports[0] : null;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fontFiles.regular, { subset: true });
  const bold = await pdf.embedFont(fontFiles.bold, { subset: true });
  const italic = await pdf.embedFont(fontFiles.italic, { subset: true });
  const supported = new Set(regular.getCharacterSet());
  const clean = (text: string) => Array.from(text.normalize("NFC").replace(/[\t\r\n]/g, " ")).map((char) => (supported.has(char.codePointAt(0) as number) ? char : "?")).join("");
  const headline = single ? `${single.managerName} · ${dateBr(single.payout.paidOn)}` : `Consolidado de ${dateBr(doc.consolidatedDate ?? null)}`;
  pdf.setTitle(clean(`Fechamento de comissão · ${headline}`));
  pdf.setAuthor(clean(doc.tenantName));
  pdf.setSubject("Relatório de fechamento de comissão dos gerentes de contas");
  pdf.setCreator("CrediAI"); pdf.setProducer("CrediAI"); pdf.setLanguage("pt-BR");
  pdf.setCreationDate(doc.generatedAt); pdf.setModificationDate(doc.generatedAt);

  type Color = ReturnType<typeof rgb>;
  const fit = (raw: string, font: PDFFont, size: number, width: number) => {
    let text = clean(raw);
    if (font.widthOfTextAtSize(text, size) <= width) return text;
    while (text.length > 1 && font.widthOfTextAtSize(`${text}…`, size) > width) text = text.slice(0, -1);
    return `${text.trimEnd()}…`;
  };
  const write = (page: PDFPage, raw: string, x: number, y: number, { size = 8.5, font = regular, color = INK, width, align = "left" }: { size?: number; font?: PDFFont; color?: Color; width?: number; align?: "left" | "right" } = {}) => {
    const text = width ? fit(raw, font, size, width) : clean(raw);
    page.drawText(text, { x: align === "right" && width ? x + width - font.widthOfTextAtSize(text, size) : x, y, size, font, color });
  };
  const wrap = (raw: string, font: PDFFont, size: number, width: number) => {
    const lines: string[] = [];
    let current = "";
    for (const word of clean(raw).split(/ +/).filter(Boolean)) {
      const next = current ? `${current} ${word}` : word;
      if (current && font.widthOfTextAtSize(next, size) > width) { lines.push(current); current = word; } else current = next;
    }
    if (current) lines.push(current);
    return lines;
  };

  // Cabeçalho de cada página (como na referência): sistema, título, página, emissão e quem emitiu; faixa da marca CrediAI.
  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    pages.push(page);
    page.drawRectangle({ x: 0, y: PAGE.height - 4, width: PAGE.width, height: 4, color: TEAL });
    page.drawRectangle({ x: MARGIN.left, y: PAGE.height - 58, width: 44, height: 26, color: NAVY });
    write(page, "CrediAI", MARGIN.left + 5, PAGE.height - 48.5, { size: 9.5, font: bold, color: WHITE });
    write(page, "CrediAI", MARGIN.left + 60, PAGE.height - 30, { size: 8.5, color: MUTED });
    write(page, single ? "Relatório de Fechamento de Comissão" : "Relatório Consolidado de Fechamento de Comissão", MARGIN.left + 60, PAGE.height - 46, { size: 14, font: bold, color: NAVY });
    write(page, doc.tenantName, MARGIN.left + 60, PAGE.height - 60, { size: 8.5, color: MUTED, width: 380 });
    const right = MARGIN.left + WIDTH - 260;
    write(page, `Página: ${pages.length}`, right, PAGE.height - 30, { size: 8.5, width: 260, align: "right" });
    write(page, `Emissão: ${dateTimeBr(doc.generatedAt)}`, right, PAGE.height - 46, { size: 8.5, width: 260, align: "right" });
    if (doc.generatedBy) write(page, `Usuário: ${doc.generatedBy}`, right, PAGE.height - 60, { size: 8.5, width: 260, align: "right" });
    y = PAGE.height - 84;
  };
  newPage();

  const ROW = 15;
  const columnHeader = () => {
    page.drawRectangle({ x: MARGIN.left, y: y - ROW + 4, width: WIDTH, height: ROW, color: HEAD_FILL });
    let x = MARGIN.left;
    for (const column of COLUMNS) { write(page, column.label, x + 4, y - 7, { size: 8, font: bold, color: INK, width: column.width - 8, align: column.align }); x += column.width; }
    page.drawLine({ start: { x: MARGIN.left, y: y - ROW + 4 }, end: { x: MARGIN.left + WIDTH, y: y - ROW + 4 }, thickness: 0.6, color: INK });
    y -= ROW + 2;
  };
  const room = (height: number) => y - height >= MARGIN.bottom;
  let currentGroup: string | null = null;
  // Título do grupo (gerente) com a data e o período do fechamento; repetido com "(continuação)" se a lista passar de página.
  const groupTitle = (label: string, detail: string) => {
    write(page, "Gerente:", MARGIN.left, y - 10, { size: 10, color: MUTED });
    write(page, label, MARGIN.left + 44, y - 10, { size: 11, font: bold, color: NAVY, width: 420 });
    write(page, detail, MARGIN.left + 470, y - 10, { size: 8.5, color: MUTED, width: WIDTH - 470, align: "right" });
    page.drawLine({ start: { x: MARGIN.left, y: y - 15 }, end: { x: MARGIN.left + WIDTH, y: y - 15 }, thickness: 1, color: NAVY });
    y -= 22;
    columnHeader();
  };
  const ensureRow = (height = ROW) => { if (!room(height)) { newPage(); if (currentGroup) groupTitle(`${currentGroup} (continuação)`, ""); } };
  const cells = (values: string[], { font = regular, size = 8.5, colors = true }: { font?: PDFFont; size?: number; colors?: boolean } = {}) => {
    let x = MARGIN.left;
    COLUMNS.forEach((column, index) => { if (values[index]) write(page, values[index], x + 4, y - 7, { size, font, color: colors && column.color ? column.color : INK, width: column.width - 8, align: column.align }); x += column.width; });
  };
  // Linha de resumo com o rótulo à esquerda da coluna Comissão e o valor nela.
  const commissionX = MARGIN.left + WIDTH - COLUMNS.at(-1)!.width;
  const summary = (label: string, value: string, { font = regular, color = INK }: { font?: PDFFont; color?: Color } = {}) => {
    ensureRow();
    write(page, label, MARGIN.left + 4, y - 7, { size: 8.5, font, color: MUTED, width: commissionX - MARGIN.left - 12, align: "right" });
    write(page, value, commissionX + 4, y - 7, { size: 8.5, font: bold, color, width: COLUMNS.at(-1)!.width - 8, align: "right" });
    y -= ROW;
  };

  for (const report of doc.reports) {
    if (!room(22 + ROW * 4)) newPage();
    currentGroup = report.managerName;
    const periodText = report.period.start ? `${dateBr(report.period.start)} a ${dateBr(report.period.end)}` : `até ${dateBr(report.period.end)} (primeiro fechamento)`;
    groupTitle(report.managerName, `Fechamento em ${dateBr(report.payout.paidOn)} · período ${periodText}`);
    let zebra = true;
    const lines = [...report.lines].sort((a, b) => (a.operationId === null ? 1 : 0) - (b.operationId === null ? 1 : 0) || a.clientName.localeCompare(b.clientName, "pt-BR") || (a.loanDate ?? "").localeCompare(b.loanDate ?? ""));
    for (const line of lines) {
      ensureRow();
      if (zebra) page.drawRectangle({ x: MARGIN.left, y: y - ROW + 4, width: WIDTH, height: ROW, color: ZEBRA });
      zebra = !zebra;
      const none = line.operationId === null;
      cells([
        none ? line.clientName : `#${line.operationCode} - ${line.clientName}`, dateBr(line.loanDate), none ? "—" : formatMoney(line.principalCents),
        none ? "—" : percent(line.interestRateBps), none ? "—" : percent(line.commissionBps), none ? "—" : percent(effectiveRateBps(line.interestRateBps, line.commissionBps)),
        none ? "—" : formatMoney(line.interestReceivedCents), formatMoney(line.commissionCents),
      ]);
      y -= ROW;
    }
    // Total do grupo (como o "Total" de cada assessor na referência), lançamentos e o valor pago ao gerente.
    ensureRow();
    const contracts = report.lines.filter((line) => line.operationId !== null);
    const principalStart = MARGIN.left + COLUMNS[0].width + COLUMNS[1].width;
    page.drawLine({ start: { x: principalStart, y: y + 3 }, end: { x: MARGIN.left + WIDTH, y: y + 3 }, thickness: 0.8, color: INK });
    cells([`${contracts.length} ${contracts.length === 1 ? "contrato" : "contratos"}`, "Total", formatMoney(contracts.reduce((sum, line) => sum + line.principalCents, 0)), "", "", "",
      formatMoney(contracts.reduce((sum, line) => sum + line.interestReceivedCents, 0)), formatMoney(report.totals.commissionCents)], { font: bold });
    y -= ROW;
    for (const item of report.adjustments) summary(`${item.kind === "CREDIT" ? "Crédito" : "Débito"} no fechamento · ${item.description} (${dateBr(item.entryDate)})`, `${item.kind === "CREDIT" ? "+" : "−"} ${formatMoney(item.amountCents)}`, { color: item.kind === "CREDIT" ? GREEN : DANGER });
    summary(`Valor pago a ${report.managerName}`, formatMoney(report.totals.finalCents), { font: bold, color: NAVY });
    // Estornos feitos depois (o fechamento não muda; o valor estornado voltou a ficar pendente).
    for (const item of report.reversals) summary(`Estorno em ${dateBr(item.createdAt.slice(0, 10))} · ${item.operationCode ? `#${item.operationCode} - ` : ""}${item.clientName} · ${item.reason}`, `− ${formatMoney(item.amountCents)}`, { color: DANGER });
    if (report.reversals.length > 0) summary("Comissão líquida após estornos", formatMoney(report.totals.commissionCents - report.totals.reversedCents), { font: bold });
    currentGroup = null;
    y -= 10;
  }

  // Total geral (faixa escura no fim, como na referência).
  const contractLines = doc.reports.flatMap((report) => report.lines).filter((line) => line.operationId !== null);
  const total = {
    contracts: contractLines.length,
    principalCents: contractLines.reduce((sum, line) => sum + line.principalCents, 0),
    interestCents: contractLines.reduce((sum, line) => sum + line.interestReceivedCents, 0),
    commissionCents: doc.reports.reduce((sum, report) => sum + report.totals.commissionCents, 0),
    debitCents: doc.reports.reduce((sum, report) => sum + report.totals.debitCents, 0),
    creditCents: doc.reports.reduce((sum, report) => sum + report.totals.creditCents, 0),
    finalCents: doc.reports.reduce((sum, report) => sum + report.totals.finalCents, 0),
  };
  if (!room(46)) newPage();
  const bands: [string, string][] = [
    ["Gerentes", String(new Set(doc.reports.map((report) => report.managerName)).size)], ["Contratos", String(total.contracts)],
    ["Valor emprestado", formatMoney(total.principalCents)], ["Juros recebidos", formatMoney(total.interestCents)], ["Comissão fechada", formatMoney(total.commissionCents)],
    ["Débitos", total.debitCents ? `− ${formatMoney(total.debitCents)}` : formatMoney(0)], ["Créditos", total.creditCents ? `+ ${formatMoney(total.creditCents)}` : formatMoney(0)],
    [single ? "Total pago ao gerente" : "Total pago aos gerentes", formatMoney(total.finalCents)],
  ];
  const widths = [60, 60, 110, 100, 105, 85, 85, 156.89];
  page.drawRectangle({ x: MARGIN.left, y: y - 38, width: WIDTH, height: 40, color: NAVY });
  let bx = MARGIN.left;
  bands.forEach(([label, value], index) => {
    const last = index === bands.length - 1;
    if (last) page.drawRectangle({ x: bx, y: y - 38, width: widths[index], height: 40, color: TEAL });
    write(page, label, bx + 6, y - 12, { size: 8, color: rgb(0.8, 0.9, 0.9), width: widths[index] - 12, align: "right" });
    write(page, value, bx + 6, y - 30, { size: last ? 12 : 10.5, font: bold, color: WHITE, width: widths[index] - 12, align: "right" });
    bx += widths[index];
  });
  y -= 56;

  // Notas.
  const unregistered = doc.reports.some((report) => report.source === "UNREGISTERED");
  const historical = doc.reports.filter((report) => report.historical);
  const notes = [
    "Comissão de cada contrato = juros efetivamente recebidos × % de comissão do gerente naquele contrato (percentual real gravado no fechamento, nunca uma taxa padrão). % efetivo de repasse = taxa de juros × % de comissão (ex.: 30% × 45% = 13,50%); com um período de juros recebido, a comissão é o valor emprestado × % efetivo (R$ 2.000,00 × 13,50% = R$ 270,00).",
    "Valores históricos gravados no fechamento: só aparecem os contratos (e os recebimentos de juros) que foram pagos nele; mudanças posteriores nos contratos não alteram este relatório.",
    ...historical.map((report) => `Composição${doc.reports.length > 1 ? ` do fechamento de ${report.managerName}` : ""} registrada em ${dateBr(report.historical!.recordedAt.slice(0, 10))} como reconstrução histórica confirmada pela responsável: ${report.historical!.reason}`),
    ...(unregistered ? ["Fechamento registrado antes do controle por contrato e sem composição confirmada: o valor gravado aparece sem divisão por contrato (nada é estimado)."] : []),
    ...doc.reports.filter((report) => report.payout.notes).map((report) => `Observação do fechamento${doc.reports.length > 1 ? ` de ${report.managerName}` : ""}: ${report.payout.notes}`),
  ];
  for (const text of notes.flatMap((note) => wrap(note, italic, 7.5, WIDTH))) {
    if (!room(10)) newPage();
    page.drawText(text, { x: MARGIN.left, y, size: 7.5, font: italic, color: MUTED });
    y -= 10;
  }

  const footer = `CrediAI · documento gerado pelo sistema${single ? ` · fechamento ${single.payout.id}` : ""}`;
  pages.forEach((current, index) => {
    current.drawLine({ start: { x: MARGIN.left, y: 34 }, end: { x: PAGE.width - MARGIN.right, y: 34 }, thickness: 0.5, color: LINE });
    current.drawText(clean(footer), { x: MARGIN.left, y: 22, size: 7.5, font: italic, color: MUTED });
    const label = `Página ${index + 1} de ${pages.length}`;
    current.drawText(label, { x: PAGE.width - MARGIN.right - regular.widthOfTextAtSize(label, 7.5), y: 22, size: 7.5, font: regular, color: MUTED });
  });
  return pdf.save({ useObjectStreams: false });
}
