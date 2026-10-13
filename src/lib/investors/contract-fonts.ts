import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ContractFontFiles } from "./contract-pdf";

// Fontes do contrato, lidas do disco uma vez por instância. Na Vercel os arquivos entram no pacote da função pelo
// outputFileTracingIncludes do next.config.ts.
const FONT_DIR = path.join(process.cwd(), "src/lib/investors/fonts");
let cached: Promise<ContractFontFiles> | null = null;

export function contractFonts() {
  cached ??= Promise.all(["Regular", "Bold", "Italic"].map((style) => readFile(path.join(FONT_DIR, `LiberationSans-${style}.ttf`))))
    .then(([regular, bold, italic]) => ({ regular, bold, italic }))
    .catch((error) => { cached = null; throw error; });
  return cached;
}
