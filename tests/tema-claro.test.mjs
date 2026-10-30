import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generate } from "../scripts/gerar-tema-claro.mjs";
import { THEME_BOOT_SCRIPT, THEME_USER_KEY, themeKey } from "../src/app/theme.ts";

const generated = readFileSync(new URL("../src/app/tema-claro.gerado.css", import.meta.url), "utf8");
const manual = readFileSync(new URL("../src/app/tema-claro.css", import.meta.url), "utf8");

test("tema claro: o arquivo gerado está em dia com globals.css", () => {
  assert.equal(generated, generate(), "rode node scripts/gerar-tema-claro.mjs");
});

test("tema claro: toda regra fica sob :root[data-theme=\"light\"] (o tema escuro não muda)", () => {
  for (const css of [generated, manual]) {
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]+(?=\{)/g).map((s) => s.trim()).filter((s) => !s.startsWith("@"));
    for (const list of selectors) for (const sel of list.split(",")) assert.match(sel.trim(), /^:root\[data-theme="light"\]|^\.theme-toggle/, sel);
  }
});

test("tema claro: a sidebar e as telas de entrada não recebem cores claras", () => {
  assert.doesNotMatch(generated, /\.sidebar|\.nav-item|\.nav-heading|\.brand|\.workspace-switcher|\.security-note|\.auth-card|\.auth-page/);
});

test("tema: preferência separada por usuário e aplicada antes da pintura", () => {
  assert.notEqual(themeKey("u_a"), themeKey("u_b"));
  assert.ok(THEME_BOOT_SCRIPT.includes(THEME_USER_KEY));
  const html = { dataset: {} };
  const store = new Map([[THEME_USER_KEY, "u_b"], [themeKey("u_a"), "light"], [themeKey("u_b"), "dark"]]);
  const run = () => new Function("localStorage", "document", THEME_BOOT_SCRIPT)({ getItem: (k) => store.get(k) ?? null }, { documentElement: html });
  run(); assert.equal(html.dataset.theme, undefined, "B escolheu escuro: não herda o claro de A");
  store.set(THEME_USER_KEY, "u_a"); run(); assert.equal(html.dataset.theme, "light");
});
