// Desenha o contrato de investimento em PDF (A4) com pdf-lib, dentro do próprio servidor: sem serviço externo.
// A fonte (Liberation Sans, licença SIL OFL, em ./fonts) vai embutida no PDF, então o contrato aparece igual em qualquer
// leitor, com todos os acentos do português. Um caractere que a fonte não tem (emoji, por exemplo) vira "?".
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { ContractBlock, ContractDocument, Run } from "./contract";

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { left: 64, right: 64, top: 70, bottom: 76 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;
const BODY = { size: 10.5, leading: 15.5 };
const INK = rgb(0.09, 0.11, 0.14);
const MUTED = rgb(0.38, 0.42, 0.47);
const RULE = rgb(0.78, 0.8, 0.83);

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont };
type GluedWord = { text: string; font: PDFFont; width: number; glue: boolean };

// Troca o que a fonte não consegue desenhar (fora do WinAnsi) por "?", e tabulações/quebras por espaço.
function sanitizer(font: PDFFont) {
  const supported = new Set(font.getCharacterSet());
  return (text: string) => Array.from(text.normalize("NFC").replace(/[\t\r\n]/g, " ")).map((char) => (supported.has(char.codePointAt(0) as number) ? char : "?")).join("");
}

export type ContractFontFiles = { regular: Uint8Array; bold: Uint8Array; italic: Uint8Array };

export async function renderContractPdf(contract: ContractDocument, generatedAt: Date, fontFiles: ContractFontFiles) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  // subset: só os caracteres usados entram no arquivo (o PDF fica com dezenas de KB, não com as fontes inteiras).
  const fonts: Fonts = {
    regular: await pdf.embedFont(fontFiles.regular, { subset: true }),
    bold: await pdf.embedFont(fontFiles.bold, { subset: true }),
    italic: await pdf.embedFont(fontFiles.italic, { subset: true }),
  };
  const clean = sanitizer(fonts.regular);
  pdf.setTitle(clean(contract.title));
  pdf.setAuthor(clean(contract.author));
  pdf.setSubject("Contrato de investimento gerado pelo sistema (sem assinaturas)");
  pdf.setCreator("CrediAI");
  pdf.setProducer("CrediAI");
  pdf.setLanguage("pt-BR");
  pdf.setCreationDate(generatedAt);
  pdf.setModificationDate(generatedAt);

  let page: PDFPage = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN.top;
  const newPage = () => { page = pdf.addPage([PAGE.width, PAGE.height]); y = PAGE.height - MARGIN.top; };
  const ensure = (height: number) => { if (y - height < MARGIN.bottom) newPage(); };

  // Palavras com a fonte de cada trecho. "glue" = colada à anterior sem espaço (ex.: o ponto depois de uma data em negrito).
  const words = (runs: Run[], size: number, fallback: PDFFont = fonts.regular) => {
    const result: GluedWord[] = [];
    let previousEndsWithSpace = true;
    for (const run of runs) {
      const text = clean(run.text);
      const font = run.bold ? fonts.bold : fallback;
      text.split(/ +/).filter(Boolean).forEach((part, index) => {
        result.push({ text: part, font, width: font.widthOfTextAtSize(part, size), glue: index === 0 && result.length > 0 && !previousEndsWithSpace && !text.startsWith(" ") });
      });
      if (text) previousEndsWithSpace = text.endsWith(" ");
    }
    return result;
  };

  // Quebra em linhas que cabem na largura. Palavras coladas ao trecho anterior (sem espaço) seguem juntas.
  function lines(items: GluedWord[], size: number, width: number) {
    const space = fonts.regular.widthOfTextAtSize(" ", size);
    const result: { words: GluedWord[]; width: number }[] = [];
    let current: GluedWord[] = [];
    let currentWidth = 0;
    for (const word of items) {
      const gap = current.length && !word.glue ? space : 0;
      if (current.length && currentWidth + gap + word.width > width && !word.glue) {
        result.push({ words: current, width: currentWidth });
        current = [];
        currentWidth = 0;
      }
      currentWidth += (current.length && !word.glue ? space : 0) + word.width;
      current.push(word);
    }
    if (current.length) result.push({ words: current, width: currentWidth });
    return { lines: result, space };
  }

  function drawWords(lineWords: GluedWord[], x: number, size: number, extraPerGap: number, space: number, color = INK) {
    let cursor = x;
    lineWords.forEach((word, index) => {
      if (index > 0 && !word.glue) cursor += space + extraPerGap;
      page.drawText(word.text, { x: cursor, y, size, font: word.font, color });
      cursor += word.width;
    });
  }

  function paragraph(runs: Run[], { size = BODY.size, leading = BODY.leading, indent = 0, justify = true, font = fonts.regular, color = INK, after = 7 } = {}) {
    const { lines: wrapped, space } = lines(words(runs, size, font), size, CONTENT_WIDTH - indent);
    wrapped.forEach((line, index) => {
      ensure(leading);
      y -= leading;
      const last = index === wrapped.length - 1;
      const gaps = line.words.filter((word, position) => position > 0 && !word.glue).length;
      const extra = justify && !last && gaps ? (CONTENT_WIDTH - indent - line.width) / gaps : 0;
      drawWords(line.words, MARGIN.left + indent, size, extra, space, color);
    });
    y -= after;
  }

  function centered(text: string, size: number, font: PDFFont, color = INK, leading = size * 1.5) {
    const { lines: wrapped, space } = lines(words([{ text }], size, font), size, CONTENT_WIDTH);
    for (const line of wrapped) {
      ensure(leading);
      y -= leading;
      drawWords(line.words, MARGIN.left + (CONTENT_WIDTH - line.width) / 2, size, 0, space, color);
    }
  }

  function signatures(block: Extract<ContractBlock, { type: "signatures" }>) {
    const partyHeight = 46 + 13 * 3;
    const witnessHeight = 46 + 13 * 3;
    // As assinaturas das partes nunca ficam separadas entre páginas.
    ensure(partyHeight * block.parties.length + 24);
    for (const party of block.parties) {
      y -= 46;
      const lineWidth = 280;
      const x = MARGIN.left + (CONTENT_WIDTH - lineWidth) / 2;
      page.drawLine({ start: { x, y }, end: { x: x + lineWidth, y }, thickness: 0.7, color: INK });
      let lineY = y - 13;
      const label = clean(party.role);
      page.drawText(label, { x: x + (lineWidth - fonts.bold.widthOfTextAtSize(label, 9.5)) / 2, y: lineY, size: 9.5, font: fonts.bold, color: INK });
      for (const text of party.lines) {
        lineY -= 12;
        const value = clean(text);
        const fitted = fit(value, fonts.regular, 9, lineWidth + 60);
        page.drawText(fitted, { x: x + (lineWidth - fonts.regular.widthOfTextAtSize(fitted, 9)) / 2, y: lineY, size: 9, font: fonts.regular, color: MUTED });
      }
      y = lineY - 4;
    }
    if (block.witnesses > 0) {
      ensure(witnessHeight + 20);
      y -= 22;
      page.drawText("TESTEMUNHAS", { x: MARGIN.left, y, size: 9.5, font: fonts.bold, color: INK });
      y -= 40;
      const columnWidth = (CONTENT_WIDTH - 32) / 2;
      for (let index = 0; index < Math.min(block.witnesses, 2); index += 1) {
        const x = MARGIN.left + index * (columnWidth + 32);
        page.drawLine({ start: { x, y }, end: { x: x + columnWidth, y }, thickness: 0.7, color: INK });
        page.drawText(`Testemunha ${index + 1}`, { x, y: y - 13, size: 9, font: fonts.bold, color: INK });
        page.drawText("Nome:", { x, y: y - 26, size: 9, font: fonts.regular, color: MUTED });
        page.drawText("CPF:", { x, y: y - 39, size: 9, font: fonts.regular, color: MUTED });
      }
      y -= 44;
    }
  }

  for (const block of contract.blocks) {
    switch (block.type) {
      case "title":
        centered(block.text, 14, fonts.bold, INK, 20);
        break;
      case "subtitle":
        centered(block.text, 8.5, fonts.regular, MUTED, 14);
        y -= 10;
        page.drawLine({ start: { x: MARGIN.left, y }, end: { x: PAGE.width - MARGIN.right, y }, thickness: 0.6, color: RULE });
        y -= 6;
        break;
      case "heading":
        // Título de cláusula nunca fica sozinho no pé da página.
        ensure(14 + 16 + BODY.leading * 2);
        y -= 14;
        paragraph([{ text: block.text, bold: true }], { justify: false, after: 3 });
        break;
      case "paragraph":
        paragraph(block.runs);
        break;
      case "quote":
        for (const line of block.text.split(/\r?\n/)) {
          if (!line.trim()) { y -= BODY.leading / 2; continue; }
          paragraph([{ text: line }], { indent: 18, justify: false, font: fonts.italic, after: 2 });
        }
        y -= 5;
        break;
      case "place-date":
        ensure(30 + BODY.leading);
        y -= 16;
        paragraph([{ text: block.text }], { justify: false });
        break;
      case "signatures":
        signatures(block);
        break;
    }
  }

  // Rodapé em todas as páginas: versão, data de geração, aviso de que não há assinaturas e a paginação.
  const pages = pdf.getPages();
  const footer = clean(contract.footer);
  pages.forEach((current, index) => {
    const footerY = 44;
    current.drawLine({ start: { x: MARGIN.left, y: footerY + 12 }, end: { x: PAGE.width - MARGIN.right, y: footerY + 12 }, thickness: 0.5, color: RULE });
    const pageLabel = `Página ${index + 1} de ${pages.length}`;
    const pageWidth = fonts.regular.widthOfTextAtSize(pageLabel, 8);
    current.drawText(fit(footer, fonts.regular, 7.5, CONTENT_WIDTH - pageWidth - 16), { x: MARGIN.left, y: footerY, size: 7.5, font: fonts.regular, color: MUTED });
    current.drawText(pageLabel, { x: PAGE.width - MARGIN.right - pageWidth, y: footerY, size: 8, font: fonts.regular, color: MUTED });
  });

  return pdf.save({ useObjectStreams: false });
}

// Corta um texto (com reticências) para caber numa largura.
function fit(text: string, font: PDFFont, size: number, width: number) {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let result = text;
  while (result.length > 1 && font.widthOfTextAtSize(`${result}…`, size) > width) result = result.slice(0, -1);
  return `${result.trimEnd()}…`;
}
