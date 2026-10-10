// Testes de navegador (Playwright/Chromium): primeiro clique antes da hidratação, banco fora do ar, sessões e
// responsividade. SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md): este teste PARA o PostgreSQL local.
//   E2E_DATABASE_URL=… E2E_PG_STOP="service postgresql stop" E2E_PG_START="service postgresql start" \
//   PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/browser.e2e.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import postgres from "postgres";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Teste destrutivo: só roda em localhost.");
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl || !/@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL precisa apontar para um banco local.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const SHOTS = process.env.E2E_SCREENSHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const admin = async (query) => sql.begin(async (tx) => { await tx`select set_config('app.crediai_role', 'SUPER_ADMIN', true)`; return tx.unsafe(query); });
const one = async (query) => Object.values((await admin(query))[0] ?? {})[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

let lastLogin = 0;
async function signIn(context, email) {
  const wait = 11_000 - (Date.now() - lastLogin);
  if (wait > 0) await sleep(wait);
  lastLogin = Date.now();
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123");
  await page.getByRole("button", { name: /Entrar/ }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  return page;
}

test("U1. clique no menu antes da hidratação não se perde: abre a tela pedida", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await signIn(context, "fernando@teste.local");
  // Atrasa o JavaScript do app em 4 s para clicar com a página ainda sem hidratação.
  await page.route("**/_next/static/chunks/**", async (route) => { await sleep(4000); await route.continue(); });
  await page.goto(BASE, { waitUntil: "commit" });
  await page.locator("aside").getByRole("link", { name: "Clientes", exact: true }).waitFor();
  await page.locator("aside").getByRole("link", { name: "Clientes", exact: true }).click();
  await page.waitForURL(/tela=clientes/, { timeout: 20_000 });
  await page.locator(".breadcrumbs strong", { hasText: "Clientes" }).waitFor({ timeout: 20_000 });
  await page.unroute("**/_next/static/chunks/**");
  // Hidratado: o clique troca a tela na hora, sem recarregar o documento, e atualiza o endereço.
  await page.waitForLoadState("networkidle");
  const documents = [];
  page.on("request", (request) => { if (request.resourceType() === "document") documents.push(request.url()); });
  await page.locator("aside").getByRole("link", { name: "Operações", exact: true }).click();
  await page.locator(".breadcrumbs strong", { hasText: "Operações" }).waitFor();
  assert.match(page.url(), /tela=operacoes/);
  assert.equal(documents.length, 0, "sem recarregar a página");
  // Recarregar mantém a tela.
  await page.reload();
  await page.locator(".breadcrumbs strong", { hasText: "Operações" }).waitFor();
  await context.close();
});

test("U2. telas sem rolagem horizontal no celular (390 px)", async () => {
  const pages = [];
  const tenant = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const tenantPage = await signIn(tenant, "fernando@teste.local");
  for (const tela of ["", "capital", "clientes", "operacoes", "pagamentos", "cobrancas", "relatorios", "configuracoes"]) pages.push([tenantPage, `/${tela ? `?tela=${tela}` : ""}`]);
  // Investidores (dados criados por investors.e2e.mjs, quando ele roda antes; senão, só a página principal).
  const investor = await one(`select id from investor where tenant_id = 'ten_fernando' order by created_at limit 1`);
  const investment = await one(`select id from investment where tenant_id = 'ten_fernando' order by created_at limit 1`);
  for (const path of ["/investidores", investor && `/investidores/${investor}`, investment && `/investidores/investimentos/${investment}`].filter(Boolean)) pages.push([tenantPage, path]);
  const master = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const masterPage = await signIn(master, "thais@teste.local");
  for (const path of ["/admin", "/admin/planos", "/admin/clientes/ten_fernando", "/admin/registros", "/admin/registros?aba=auditoria", "/admin/registros?aba=tenants", "/admin/registros?aba=operacoes", "/investidores"]) pages.push([masterPage, path]);
  for (const [page, path] of pages) {
    await page.goto(`${BASE}${path}`);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${path}: ${overflow}px de rolagem horizontal`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "dashboard"}.png`, fullPage: false });
  }
  await tenant.close();
  await master.close();
});

test("U5. Investidores pelo menu: cadastro pelo formulário, ficha, novo investimento e contrato (desktop)", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await signIn(context, "roberio@teste.local");
  await page.locator("aside").getByRole("link", { name: "Investidores", exact: true }).click();
  await page.waitForURL(/\/investidores$/);
  await page.locator(".breadcrumbs strong", { hasText: "Investidores" }).waitFor();
  for (const card of ["Capital investido", "Investimentos ativos", "Rendimentos previstos", "Rendimentos pagos", "Total a devolver", "Próximos vencimentos"]) await page.locator(".metric-card", { hasText: card }).waitFor();
  await page.getByRole("button", { name: /Novo investidor/ }).click();
  const form = page.locator("form", { has: page.locator('input[name="name"]') }).first();
  await form.locator('input[name="name"]').fill("Investidor pelo Navegador");
  await form.locator('input[name="document"]').fill("52998224725");
  assert.equal(await form.locator('input[name="document"]').inputValue(), "529.982.247-25", "máscara de CPF");
  await form.locator('input[name="whatsapp"]').fill("11987650000");
  await form.locator('input[name="instagram"]').fill("@navegador");
  await form.getByRole("button", { name: /Cadastrar investidor/ }).click();
  await page.getByRole("link", { name: "Investidor pelo Navegador" }).waitFor({ timeout: 15_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-investidores.png`, fullPage: true });
  await page.getByRole("link", { name: "Investidor pelo Navegador" }).click();
  await page.waitForURL(/\/investidores\/inv_/);
  await page.getByRole("link", { name: "@navegador" }).waitFor();
  await page.getByRole("button", { name: /Novo investimento/ }).click();
  await page.locator('input[name="amount"]').fill("20.000,00");
  await page.locator('input[name="rate"]').fill("2");
  await page.locator('select[name="ratePeriod"]').selectOption("MONTHLY");
  await page.getByRole("button", { name: /Cadastrar investimento/ }).click();
  await page.getByRole("cell", { name: "R$ 20.000,00" }).waitFor({ timeout: 15_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-investidor.png`, fullPage: true });
  await page.getByRole("link", { name: "Abrir" }).first().click();
  await page.waitForURL(/\/investidores\/investimentos\//);
  await page.getByText("Contrato assinado ainda não enviado").waitFor();
  await page.locator('input[name="file"]').setInputFiles({ name: "contrato.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 navegador") });
  await page.getByRole("button", { name: /Enviar documento/ }).click();
  await page.getByRole("link", { name: "Visualizar" }).waitFor({ timeout: 15_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-investimento.png`, fullPage: true });
  await context.close();
});

test("U3. banco fora do ar: tela de nova tentativa, sem ir para /setup e sem perder a sessão", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await signIn(context, "fernando@teste.local");
  const sessionsBefore = Number(await one("select count(*) from session where user_id = 'u_fernando'"));
  await sql.end();
  execSync(process.env.E2E_PG_STOP ?? "service postgresql stop", { stdio: "ignore" });
  try {
    await page.goto(BASE);
    assert.equal(new URL(page.url()).pathname, "/", "continua em /, sem redirecionar para /setup");
    await page.getByText("Não conseguimos falar com o banco de dados agora").waitFor({ timeout: 30_000 });
    assert.ok(await page.getByText("sua sessão continua aberta").isVisible());
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/banco-indisponivel.png` });
    assert.ok((await context.cookies()).some((cookie) => cookie.name.includes("session_token")), "cookie de sessão preservado");
  } finally {
    execSync(process.env.E2E_PG_START ?? "service postgresql start", { stdio: "ignore" });
  }
  sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  for (let attempt = 0; attempt < 30; attempt++) { try { await one("select 1"); break; } catch { await sleep(1000); } }
  await page.getByRole("link", { name: /Tentar novamente/ }).click();
  await page.locator("aside").getByRole("link", { name: "Clientes", exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(Number(await one("select count(*) from session where user_id = 'u_fernando'")), sessionsBefore, "nenhuma sessão apagada");
  await context.close();
});

test("U4. sessões: várias sessões, saída encerra só a própria, sessão vencida volta ao login, senha provisória exige troca", async () => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const a = await signIn(first, "roberio@teste.local");
  const b = await signIn(second, "roberio@teste.local");
  assert.ok(Number(await one("select count(*) from session where user_id = 'u_roberio'")) >= 2, "duas sessões ao mesmo tempo");
  await a.getByRole("button", { name: /Menu da conta/ }).click();
  await a.getByRole("menuitem", { name: /Sair/ }).click();
  await a.waitForURL(/\/login/);
  await a.goto(BASE);
  assert.match(a.url(), /\/login/, "depois de sair, / pede login");
  await b.goto(`${BASE}/?tela=clientes`);
  assert.doesNotMatch(b.url(), /\/login/, "a outra sessão continua valendo");
  // Sessão vencida (simulada no banco local): volta ao login.
  await admin("update session set expires_at = now() - interval '1 minute' where user_id = 'u_roberio'");
  await b.goto(BASE);
  assert.match(b.url(), /\/login/);
  // Senha provisória: só a tela de troca de senha fica liberada.
  await admin("update \"user\" set must_change_password = true where id = 'u_roberio'");
  const c = await signIn(second, "roberio@teste.local");
  await c.goto(BASE);
  assert.match(c.url(), /\/definir-senha/);
  await c.goto(`${BASE}/admin`);
  assert.match(c.url(), /\/definir-senha/);
  await admin("update \"user\" set must_change_password = false where id = 'u_roberio'");
  await first.close();
  await second.close();
});

test("encerramento", async () => { await browser.close(); await sql.end(); });
