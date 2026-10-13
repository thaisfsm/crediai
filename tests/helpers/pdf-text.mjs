// Extrai o texto de um PDF gerado pelo CrediAI (pdf-lib, fontes TrueType embutidas com ToUnicode), sem dependências:
// lê os objetos, descomprime os streams, monta o mapa glifo -> caractere de cada fonte e percorre os Tj de cada página.
// Palavras na mesma linha são unidas por espaço; cada linha nova (Tm com outro y) vira uma quebra de linha.
import { inflateSync } from "node:zlib";

function objects(bytes) {
  const raw = Buffer.from(bytes).toString("latin1");
  const result = new Map();
  for (const match of raw.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    const body = match[2];
    const streamAt = body.indexOf("stream");
    const dict = streamAt >= 0 ? body.slice(0, streamAt) : body;
    let stream = null;
    if (streamAt >= 0) {
      const start = body.indexOf("\n", streamAt) + 1;
      const length = Number(/\/Length (\d+)/.exec(dict)?.[1]);
      const data = Buffer.from(body.slice(start, start + length), "latin1");
      stream = /\/FlateDecode/.test(dict) ? inflateSync(data) : data;
    }
    result.set(Number(match[1]), { dict, stream });
  }
  return result;
}

const hexToString = (hex) => String.fromCodePoint(...(hex.match(/.{4}/g) ?? []).map((code) => parseInt(code, 16)));

function toUnicode(cmap) {
  const map = new Map();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, cid, unicode] of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(cid, 16), hexToString(unicode));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, from, to, rest] of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)/g)) {
      const start = parseInt(from, 16);
      const end = parseInt(to, 16);
      if (rest.startsWith("[")) [...rest.matchAll(/<([0-9A-Fa-f]+)>/g)].forEach(([, unicode], index) => map.set(start + index, hexToString(unicode)));
      else { const base = parseInt(rest.slice(1, -1), 16); for (let cid = start; cid <= end; cid += 1) map.set(cid, String.fromCodePoint(base + cid - start)); }
    }
  }
  return map;
}

export function pdfPages(bytes) {
  const objs = objects(bytes);
  const fontMaps = new Map();
  for (const [number, { dict }] of objs) {
    const ref = /\/ToUnicode (\d+) 0 R/.exec(dict);
    if (ref) fontMaps.set(number, toUnicode(objs.get(Number(ref[1])).stream.toString("latin1")));
  }
  const kids = /\/Kids \[([^\]]*)\]/.exec([...objs.values()].find((obj) => /\/Type \/Pages/.test(obj.dict)).dict)[1];
  return [...kids.matchAll(/(\d+) 0 R/g)].map(([, pageNumber]) => {
    const page = objs.get(Number(pageNumber)).dict;
    const fonts = new Map([...(/\/Font <<([\s\S]*?)>>/.exec(page)?.[1] ?? "").matchAll(/\/(\S+) (\d+) 0 R/g)].map(([, name, ref]) => [name, Number(ref)]));
    const contents = /\/Contents \[?([\d\s0R]+)\]?/.exec(page)[1];
    const content = [...contents.matchAll(/(\d+) 0 R/g)].map(([, ref]) => objs.get(Number(ref)).stream.toString("latin1")).join("\n");
    const lines = [];
    let font = null;
    let y = null;
    for (const token of content.matchAll(/\/(\S+) [\d.]+ Tf|[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ ([-\d.]+) Tm|<([0-9A-Fa-f]*)> Tj/g)) {
      if (token[1]) font = fontMaps.get(fonts.get(token[1]));
      else if (token[2]) y = token[2];
      else {
        const text = (token[3].match(/.{4}/g) ?? []).map((cid) => font?.get(parseInt(cid, 16)) ?? "�").join("");
        const last = lines.at(-1);
        if (last && last.y === y) last.words.push(text); else lines.push({ y, words: [text] });
      }
    }
    return lines.map((line) => line.words.join(" ")).join("\n");
  });
}

// Texto corrido para conferências: espaços normais no lugar do espaço não separável, sem espaço antes de pontuação.
export const pdfText = (bytes) => pdfPages(bytes).join("\n").replace(/ /g, " ").replace(/ ([.,;:)])/g, "$1");
