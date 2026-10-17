// Preenchimento pelo CPF (só leitura): ao digitar um CPF válido no cadastro de cliente, os campos vazios são preenchidos
// com o cadastro de investidor da MESMA carteira (e o contrário); CPF inválido não busca; o que já foi digitado não é
// apagado; outra carteira não vê nem recebe os dados; nada é gravado. SÓ em ambiente LOCAL e DESCARTÁVEL (README).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Teste destrutivo: só roda em localhost.");
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl || !/@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL precisa apontar para um banco local.");
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const admin = async (query) => sql.begin(async (tx) => { await tx`select set_config('app.crediai_role', 'SUPER_ADMIN', true)`; return tx.unsafe(query); });
const one = async (query) => Object.values((await admin(query))[0] ?? {})[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
after(async () => { await browser?.close(); await sql.end(); });

const CPF = "393.124.308-74";
const login = async (email) => {
  await sleep(11_000);
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123" }) });
  assert.equal(response.status, 200, `login de ${email}`);
  return response.headers.getSetCookie().find((cookie) => cookie.includes("session_token")).split(";")[0].split(/=(.*)/s);
};
const open = async (cookie, path) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: cookie[0], value: cookie[1], domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto(`${BASE}${path}`);
  return page;
};

test("preenchimento pelo CPF: investidor → cliente, cliente → investidor, inválido, digitado preservado e isolamento", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  await admin(`insert into investor(id,tenant_id,name,document,phone,email,address_cep,address_street,address_number,address_city,address_state,person_type,status)
    values ('inv_prefill','ten_thais','Maria Preenchida','39312430874','11987654321','maria@exemplo.com','01310100','Avenida Paulista','1000','São Paulo','SP','PF','ACTIVE')`);
  await admin(`insert into client(id,tenant_id,name,document,phone) values ('c_prefill','ten_thais','Cliente Antigo','11144477735','11999990000')`);
  const before = { clients: await one(`select count(*)::int from client`), investors: await one(`select count(*)::int from investor`) };
  const thais = await login("thais@teste.local");

  // Cliente: CPF de investidor da mesma carteira preenche só o que está vazio.
  let page = await open(thais, "/?tela=clientes");
  await page.locator('input[name="phone"]').first().fill("(11) 91111-2222");
  await page.locator('input[name="document"]').fill("393.124.308-75");
  await sleep(1500);
  assert.equal(await page.locator('input[name="name"]').first().inputValue(), "", "CPF inválido não busca nada");
  await page.locator('input[name="document"]').fill(CPF);
  await page.getByText("Campos vazios preenchidos com o cadastro de investidor Maria Preenchida").waitFor();
  assert.equal(await page.locator('input[name="name"]').first().inputValue(), "Maria Preenchida");
  assert.equal(await page.locator('input[name="phone"]').first().inputValue(), "(11) 91111-2222", "o telefone digitado não é apagado");
  assert.equal(await page.locator('input[name="email"]').first().inputValue(), "maria@exemplo.com");
  assert.equal(await page.locator('input[name="residentialStreet"]').inputValue(), "Avenida Paulista");
  assert.equal(await page.locator('input[name="residentialCity"]').inputValue(), "São Paulo");
  assert.equal(await page.locator('select[name="residentialState"]').inputValue(), "SP");
  await page.screenshot({ path: process.env.E2E_SHOT ?? "/tmp/preenchimento-cpf.png" });
  await page.context().close();

  // CPF que já é cliente: só avisa, não preenche.
  page = await open(thais, "/?tela=clientes");
  await page.locator('input[name="document"]').fill("111.444.777-35");
  await page.getByText("Este CPF já está cadastrado como cliente: Cliente Antigo").waitFor();
  assert.equal(await page.locator('input[name="name"]').first().inputValue(), "");
  await page.context().close();

  // Investidor: CPF de cliente da mesma carteira preenche o cadastro do investidor.
  page = await open(thais, "/investidores");
  await page.getByRole("button", { name: "Novo investidor" }).click();
  const form = page.getByRole("region", { name: "Novo investidor" });
  await form.getByLabel("Tipo de pessoa").selectOption("PF");
  await form.locator('input[name="document"]').fill("111.444.777-35");
  await page.getByText("Campos vazios preenchidos com o cadastro de cliente Cliente Antigo").waitFor();
  assert.equal(await form.locator('input[name="name"]').inputValue(), "Cliente Antigo");
  await page.context().close();

  // Outra carteira não recebe nada.
  const roberio = await login("roberio@teste.local");
  page = await open(roberio, "/?tela=clientes");
  await page.locator('input[name="document"]').fill(CPF);
  await sleep(2000);
  assert.equal(await page.locator('input[name="name"]').first().inputValue(), "", "outra carteira não vê o investidor da Thaís");
  assert.equal(await page.getByText("Campos vazios preenchidos").count(), 0);
  await page.context().close();

  assert.deepEqual({ clients: await one(`select count(*)::int from client`), investors: await one(`select count(*)::int from investor`) }, before, "nada foi gravado");
});
