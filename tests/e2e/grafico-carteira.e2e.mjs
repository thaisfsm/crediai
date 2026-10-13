// Tooltip do gráfico "Evolução da carteira" no navegador (Playwright/Chromium). Só LÊ dados: entra como fernando@ e
// passa o mouse em cada bolinha nos períodos 7D, 30D e 90D, no desktop e no celular.
//   PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/grafico-carteira.e2e.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Teste local: só roda em localhost.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const brl = (cents) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/\s/g, " ");
const dmy = (iso) => iso.split("-").reverse().join("/");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function dashboard(viewport) {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("E-mail").fill("fernando@teste.local");
  await page.getByLabel("Senha").fill(process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123");
  await page.getByRole("button", { name: /Entrar/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  await page.goto(BASE); // carga completa: a série do gráfico vem no HTML
  await page.locator(".wallet-chart").waitFor();
  await page.waitForLoadState("networkidle");
  // Série que o servidor mandou ao gráfico: é o que cada tooltip tem de repetir.
  const match = (await page.content()).replace(/\\"/g, '"').match(/"chart":(\{"7D":.*?\}\})/);
  assert.ok(match, "série do gráfico encontrada na página");
  return { page, chart: JSON.parse(match[1]) };
}

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
  test(`G. ${name}: cada bolinha mostra a própria data e o próprio saldo (7D, 30D, 90D)`, async () => {
    if (name === "celular") await sleep(11_000); // limite de tentativas de login
    const { page, chart } = await dashboard(viewport);
    // O SVG não tem mais <title>: o navegador não mostra "Evolução da carteira" como tooltip nativo.
    assert.equal(await page.locator(".wallet-chart title").count(), 0);
    assert.equal(await page.locator(".wallet-chart").getAttribute("aria-label"), "Evolução da carteira");
    for (const period of ["7D", "30D", "90D"]) {
      await page.locator(".period-switch button", { hasText: period }).click();
      await page.locator(".wallet-chart").evaluate((element) => element.scrollIntoView({ block: "center" }));
      const dots = page.locator(".wallet-chart circle.chart-dot");
      assert.equal(await dots.count(), chart[period].values.length);
      for (let index = 0; index < chart[period].values.length; index++) {
        const box = await dots.nth(index).boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        const tooltip = page.locator(".chart-tooltip");
        await tooltip.waitFor();
        assert.equal((await tooltip.innerText()).replace(/\s+/g, " ").trim(), `${dmy(chart[period].dates[index])} ${brl(chart[period].values[index])} Saldo a receber`, `${period} ponto ${index + 1}`);
        const tip = await tooltip.boundingBox();
        assert.ok(tip.x >= 0 && tip.x + tip.width <= viewport.width, `${period} ponto ${index + 1}: tooltip dentro da tela`);
        assert.ok(Math.abs(tip.x + tip.width / 2 - (box.x + box.width / 2)) < 90, `${period} ponto ${index + 1}: tooltip junto da bolinha`);
      }
      // Teclado: focar um ponto mostra o tooltip dele; sair do gráfico esconde.
      await page.locator(".chart-hit").nth(1).focus();
      assert.equal((await page.locator(".chart-tooltip").innerText()).replace(/\s+/g, " ").trim(), `${dmy(chart[period].dates[1])} ${brl(chart[period].values[1])} Saldo a receber`);
      await page.locator(".chart-hit").nth(1).blur();
      await page.mouse.move(1, 1);
      assert.equal(await page.locator(".chart-tooltip").count(), 0);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, "sem rolagem horizontal");
  });
}

test.after(() => browser.close());
