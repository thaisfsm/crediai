// Gera src/app/tema-claro.gerado.css a partir do sistema escuro de src/app/globals.css.
// O tema escuro tem as cores escritas regra a regra; em vez de reescrever cada componente, este script lê as mesmas
// regras e produz a versão clara de cada cor, escopada em :root[data-theme="light"] (o tema escuro não muda).
// A sidebar e as telas de entrada (login, setup) ficam de fora: continuam escuras nos dois temas.
// Ajustes finos e os tokens do tema claro ficam à mão em src/app/tema-claro.css (carregado depois deste arquivo).
//   node scripts/gerar-tema-claro.mjs            → regrava o arquivo gerado
//   node scripts/gerar-tema-claro.mjs --check    → falha se o arquivo gerado estiver desatualizado (usado no teste)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = `${root}src/app/globals.css`;
const TARGET = `${root}src/app/tema-claro.gerado.css`;
const MARKER = "/* CrediAI dark fintech system */";
const SCOPE = ':root[data-theme="light"]';

// Seletores que continuam escuros: menu lateral e telas de entrada (antes do login não há preferência de usuário).
const KEEP_DARK = /\.sidebar|\.side-nav|\.nav-(item|heading|group|count)|\.brand|\.workspace-(switcher|avatar|copy)|\.security-(note|icon)|\.help-link|\.profile-button|\.profile-copy|\.auth-|\.setup-(page|card|note)|\.proposal-|\.mobile-scrim|\.admin-modules/;
const COLOR_PROPS = /^(color|background(-color|-image)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|filter|caret-color|text-decoration(-color)?|-webkit-text-fill-color|-webkit-box-shadow|accent-color|color-scheme|stop-color|--[\w-]+)$/;

// ---- cores -------------------------------------------------------------------------------------------------------
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b(?!-)/g;
const HAS_COLOR = new RegExp(COLOR_RE.source);
function parseColor(text) {
  if (text === "white") return [255, 255, 255, 1];
  if (text === "black") return [0, 0, 0, 1];
  if (text[0] === "#") {
    let h = text.slice(1);
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const parts = text.slice(text.indexOf("(") + 1, -1).split(/[\s,/]+/).filter(Boolean).map(Number);
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s, l, chroma: d };
}
function fromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}
const fmt = ([r, g, b], a) => (a >= 1 ? `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}` : `rgba(${r},${g},${b},${+a.toFixed(3)})`);
const NAVY = [16, 42, 66];
// Tom de destaque legível sobre branco: mesma cor (vermelho continua vermelho, ciano continua ciano), mais escura.
const accentLightness = (h) => (h < 20 || h >= 330 ? 0.43 : h < 70 ? 0.35 : 0.3);

// kind: "text" (texto e ícones), "bg" (fundos), "line" (bordas e divisórias), "shadow" (sombras e brilhos)
function lightColor(text, kind) {
  const [r, g, b, a] = parseColor(text);
  if (a === 0) return text;
  const { h, s, l, chroma } = toHsl([r, g, b]);
  const accent = chroma >= 0.28;
  if (kind === "text") {
    if (l < 0.3) return fmt([255, 255, 255], a); // texto escuro só aparece sobre destaque claro → vira branco sobre destaque escurecido
    if (accent) return fmt(fromHsl(h, clamp(s, 0.45, 0.8), Math.min(l, accentLightness(h))), a);
    return fmt(fromHsl(h, Math.min(s, 0.32), clamp(0.95 - l, 0.14, 0.47)), a);
  }
  if (kind === "line") {
    if (accent) return fmt(fromHsl(h, clamp(s, 0.4, 0.75), 0.42), clamp(a * 0.9, 0.12, 1));
    if (a < 1) return fmt(NAVY, clamp(a * 0.75, 0.08, 0.3));
    return fmt(fromHsl(h, Math.min(s, 0.25), clamp(1.02 - l, 0.78, 0.92)), 1);
  }
  if (kind === "shadow") {
    if (l < 0.3) return fmt([15, 35, 55], +(a * 0.28).toFixed(3));
    if (accent) return fmt(fromHsl(h, clamp(s, 0.4, 0.75), 0.45), +(a * 0.45).toFixed(3));
    return fmt([255, 255, 255], 0);
  }
  // bg
  if (l < 0.3) {
    if (a >= 0.85) return "#ffffff"; // superfícies (cards, campos, painéis) → branco
    if (a >= 0.4) return fmt([241, 245, 249], a); // camadas escuras semitransparentes → cinza muito claro
    return fmt(NAVY, +(a * 0.3).toFixed(3)); // véus escuros leves → sombreado discreto
  }
  if (accent) {
    if (a < 1) return fmt(fromHsl(h, clamp(s, 0.45, 0.8), Math.min(l, 0.45)), +clamp(a * 0.9, 0.04, 1).toFixed(3));
    return fmt(fromHsl(h, clamp(s, 0.5, 0.85), Math.min(l, accentLightness(h))), 1); // botões e marcas cheias
  }
  if (a < 1) return fmt(NAVY, clamp(a * 0.7, 0.025, 0.12)); // brilho claro sobre escuro → leve sombreado sobre branco
  return fmt(fromHsl(h, Math.min(s, 0.25), clamp(1 - l, 0.62, 0.97)), 1);
}

function kindFor(prop) {
  if (prop === "color" || prop === "caret-color" || prop === "-webkit-text-fill-color" || prop === "accent-color" || prop === "stop-color") return "text";
  if (prop.startsWith("border") || prop.startsWith("outline") || prop === "stroke" || prop.startsWith("text-decoration")) return "line";
  if (prop.includes("shadow") || prop === "filter") return "shadow";
  if (prop === "fill") return null; // decidido por cor (abaixo)
  if (prop.startsWith("--")) return /line|border/.test(prop) ? "line" : /card|surface|canvas|bg|panel/.test(prop) ? "bg" : "text";
  return "bg";
}

// Fundo cheio de destaque (botão, aba ativa): o texto claro dele continua branco, como no tema escuro.
function hasSolidAccentBackground(decls) {
  return decls.some(([prop, value]) => prop.startsWith("background") && (value.match(COLOR_RE) ?? []).some((c) => {
    const [r, g, b, a] = parseColor(c); const { l, chroma } = toHsl([r, g, b]);
    return a >= 0.9 && chroma >= 0.28 && l >= 0.3;
  }));
}

function convertValue(prop, value, onAccent = false) {
  if (prop === "color-scheme") return value.replace(/\bdark\b/, "light");
  if (onAccent && prop === "color") return value.replace(COLOR_RE, (match) => (toHsl(parseColor(match)).l > 0.85 ? match : lightColor(match, "text")));
  const kind = kindFor(prop);
  // Sombras com "inset 0 0 0 1000px" pintam o fundo do campo (autopreenchimento): tratam como fundo.
  return value.replace(COLOR_RE, (match) => {
    let k = kind;
    if (prop === "fill") k = toHsl(parseColor(match)).l < 0.25 ? "bg" : "text";
    if (prop.includes("box-shadow") && /1000px/.test(value)) k = "bg";
    if (prop === "stroke" && toHsl(parseColor(match)).chroma >= 0.28) k = "text";
    return lightColor(match, k);
  });
}

// ---- CSS ---------------------------------------------------------------------------------------------------------
function parseBlock(css, i = 0) {
  const nodes = [];
  let buf = "";
  while (i < css.length) {
    const c = css[i];
    if (c === "{") {
      const prelude = buf.trim(); buf = "";
      if (prelude.startsWith("@")) {
        const [children, next] = parseBlock(css, i + 1);
        nodes.push({ at: prelude, children }); i = next; continue;
      }
      const end = css.indexOf("}", i);
      nodes.push({ selector: prelude, body: css.slice(i + 1, end) }); i = end + 1; continue;
    }
    if (c === "}") return [nodes, i + 1];
    buf += c; i++;
  }
  return [nodes, i];
}
function splitTop(text, sep) {
  const out = []; let depth = 0, cur = "";
  for (const c of text) {
    if (c === "(") depth++; else if (c === ")") depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function scopeSelector(sel) {
  sel = sel.trim();
  if (sel === "html" || sel === ":root") return SCOPE;
  if (sel.startsWith("html")) return SCOPE + sel.slice(4);
  return `${SCOPE} ${sel}`;
}
function convertRule(node) {
  const selectors = splitTop(node.selector, ",").map((s) => s.trim()).filter((s) => s && !KEEP_DARK.test(s));
  if (!selectors.length) return "";
  const pairs = splitTop(node.body, ";").map((d) => d.trim()).filter((d) => d.includes(":"))
    .map((d) => [d.slice(0, d.indexOf(":")).trim().toLowerCase(), d.slice(d.indexOf(":") + 1).trim()]);
  const onAccent = hasSolidAccentBackground(pairs);
  const decls = pairs.flatMap(([prop, value]) => {
    if (!COLOR_PROPS.test(prop)) return [];
    if (prop !== "color-scheme" && !HAS_COLOR.test(value)) return [];
    const next = convertValue(prop, value, onAccent);
    return next === value ? [] : [`${prop}:${next}`];
  });
  if (!decls.length) return "";
  return `${selectors.map(scopeSelector).join(",")} { ${decls.join("; ")}; }`;
}
function render(nodes) {
  return nodes.flatMap((n) => {
    if (n.at) {
      if (/^@keyframes/.test(n.at)) return [];
      const inner = render(n.children);
      return inner.length ? [`${n.at} {\n${inner.map((l) => `  ${l}`).join("\n")}\n}`] : [];
    }
    const out = convertRule(n);
    return out ? [out] : [];
  });
}

export function generate() {
  const css = readFileSync(SOURCE, "utf8");
  const start = css.indexOf(MARKER);
  if (start < 0) throw new Error("marcador do sistema escuro não encontrado em globals.css");
  const dark = css.slice(start).replace(/\/\*[\s\S]*?\*\//g, "");
  const [nodes] = parseBlock(dark);
  return `/* Arquivo GERADO por scripts/gerar-tema-claro.mjs a partir de globals.css. Não editar à mão: rode o script.\n   Ajustes do tema claro ficam em tema-claro.css. */\n${render(nodes).join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = generate();
  if (process.argv.includes("--check")) {
    if (readFileSync(TARGET, "utf8") !== out) { console.error("tema-claro.gerado.css desatualizado: rode node scripts/gerar-tema-claro.mjs"); process.exit(1); }
    console.log("tema-claro.gerado.css em dia");
  } else {
    writeFileSync(TARGET, out);
    console.log(`gerado ${TARGET} (${out.split("\n").length} linhas)`);
  }
}
