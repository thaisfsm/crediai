// Investidores (Etapa B e evolução da migração 0024), de ponta a ponta (HTTP + banco + navegador): pessoa física ou
// jurídica com CPF/CNPJ conferido, contas bancárias mascaradas e fora da auditoria, documentos do investidor, campos
// novos do contrato (contratação, recebimento, prazo com unidade, forma de pagamento, conta, condições), cronograma
// revisado antes de gravar (sem duplicar), modelo padrão e negociação personalizada pela tela, histórico, isolamento
// entre tenants, visão do MASTER e nenhum efeito no capital ou nos dados que já existiam.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md). Usa os dados fictícios ten_roberio (A), ten_fernando (B)
// e ten_thais (MASTER).
//   E2E_DATABASE_URL=… PLAYWRIGHT_MODULE=/caminho/playwright/index.mjs node --test tests/e2e/investidores-cronograma.e2e.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import postgres from "postgres";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Teste destrutivo: só roda em localhost.");
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl || !/@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl)) throw new Error("E2E_DATABASE_URL precisa apontar para um banco local.");
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const admin = async (query) => sql.begin(async (tx) => { await tx`select set_config('app.crediai_role', 'SUPER_ADMIN', true)`; return tx.unsafe(query); });
const one = async (query) => Object.values((await admin(query))[0] ?? {})[0];
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const actionId = (name) => Object.entries(manifest).find(([, value]) => value.exportedName === name)?.[0] ?? assert.fail(`ação ${name} não encontrada no build`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const SHOTS = process.env.E2E_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
let browser;
after(async () => { await browser?.close(); await sql.end(); });

let lastLogin = 0;
async function login(email) {
  const wait = 11_000 - (Date.now() - lastLogin);
  if (wait > 0) await sleep(wait);
  lastLogin = Date.now();
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email, password: process.env.E2E_PASSWORD ?? "Senha-Teste-Local-123" }) });
  assert.equal(response.status, 200, `login de ${email}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function action(cookie, name, fields, files = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value);
  for (const [key, [content, type, fileName]] of Object.entries(files)) form.append(`_1_${key}`, new Blob([content], { type }), fileName);
  form.append("0", '["$K1"]');
  const response = await fetch(`${BASE}/investidores`, { method: "POST", headers: { cookie, "next-action": actionId(name), accept: "text/x-component", origin: BASE }, body: form });
  const result = (await response.text()).match(/^1:(\{.*\})$/m)?.[1];
  return result ? JSON.parse(result) : null;
}
const page = async (cookie, path) => {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual", headers: { cookie } });
  return { status: response.status, html: response.status === 200 ? text(await response.text()) : "", raw: "" };
};
// Tudo o que este módulo não pode tocar: operações, pagamentos, capital, carteiras, clientes, tenants e usuários.
const protectedHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o union all select 'p'||row(p.*)::text from payment p union all select 'r'||row(r.*)::text from loan_renewal r
  union all select 'w'||row(w.*)::text from wallet w union all select 'm'||row(m.*)::text from capital_movement m union all select 'c'||row(c.*)::text from client c
  union all select 't'||row(t.*)::text from tenant t union all select 'u'||concat_ws(',', u.id, u.name, u.email, u.role, u.tenant_id, u.active) from "user" u) t`);
const items = (investmentId) => admin(`select number, due_date::text, yield_cents::int, principal_cents::int, description from investment_schedule_item where investment_id = '${investmentId}' order by due_date, number`);

const lines = (investmentId, list, extra = {}) => action(robério, "saveInvestmentScheduleLinesAction", { investmentId, mode: "replace", lines: JSON.stringify(list), ...extra });
// Modelo padrão de 12 meses (o mesmo que o botão monta): rendimento mensal digitado e o principal integral na última data.
const monthly = (first, count, yieldAmount, principal) => Array.from({ length: count }, (_, index) => {
  const date = new Date(`${first}T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + index);
  const last = index === count - 1 && principal;
  return { kind: last ? "COMBINED" : "YIELD", dueDate: date.toISOString().slice(0, 10), yieldAmount, principalAmount: last ? principal : "", description: "Rendimento mensal" };
});
const PDF = "%PDF-1.4 documento de teste";
// Versão do cronograma que a tela envia (mesma conta de scheduleVersion em src/lib/investors/rules.ts).
const version = async (investmentId) => {
  const rows = await admin(`select id, updated_at from investment_schedule_item where investment_id = '${investmentId}'`);
  const textValue = rows.map((row) => `${row.id}@${row.updated_at.toISOString()}`).sort().join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < textValue.length; index++) hash = Math.imul(hash ^ textValue.charCodeAt(index), 0x01000193) >>> 0;
  return `${rows.length}-${hash.toString(36)}`;
};

let robério, fernando, thais, hashBefore;
const ids = {};

test("preparação", async () => {
  hashBefore = await protectedHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  thais = await login("thais@teste.local");
});

test("IC1. investidor PF/PJ: CPF/CNPJ conferido pelo tipo, único na carteira; investidor antigo sem tipo continua igual", async () => {
  const invalid = await action(robério, "createInvestorAction", { personType: "PF", name: "CPF Errado", document: "411.797.058-59" });
  assert.equal(invalid?.ok, false);
  assert.match(invalid.error, /CPF inválido/);
  assert.equal((await action(robério, "createInvestorAction", { personType: "PJ", name: "CNPJ Errado", document: "12.345.678/0001-90" }))?.ok, false);
  assert.match((await action(robério, "createInvestorAction", { personType: "PJ", name: "Tipo Trocado", document: "411.797.058-58" }))?.error, /CNPJ/);
  assert.match((await action(robério, "createInvestorAction", { name: "Sem Tipo", document: "411.797.058-58" }))?.error, /pessoa física ou pessoa jurídica/);
  assert.equal(await one("select count(*)::int from investor where name in ('CPF Errado', 'CNPJ Errado', 'Tipo Trocado', 'Sem Tipo')"), 0);
  const created = await action(robério, "createInvestorAction", { personType: "PF", name: "Marta Cronograma", document: "411.797.058-58", birthDate: "1980-05-20", bankName: "ignorado", pixKey: "ignorado" });
  assert.equal(created?.ok, true, JSON.stringify(created));
  ids.investor = created.id;
  const [row] = await admin(`select * from investor where id = '${ids.investor}'`);
  assert.deepEqual([row.tenant_id, row.person_type, row.document, row.birth_date?.toISOString?.().slice(0, 10) ?? String(row.birth_date)], ["ten_roberio", "PF", "41179705858", "1980-05-20"]);
  assert.equal(row.bank_name, null, "dados bancários não ficam mais no cadastro do investidor");
  const company = await action(robério, "createInvestorAction", { personType: "PJ", name: "Empresa Investidora Ltda", tradeName: "Investe Já", document: "11.222.333/0001-81", birthDate: "2015-03-01" });
  assert.equal(company?.ok, true, JSON.stringify(company));
  ids.company = company.id;
  assert.match((await action(robério, "createInvestorAction", { personType: "PF", name: "Repetido", document: "41179705858" }))?.error, /CPF\/CNPJ/);
  // Outra carteira pode ter o mesmo CPF.
  const other = await action(fernando, "createInvestorAction", { personType: "PF", document: "411.797.058-58", name: "Investidor B Cronograma" });
  assert.equal(other?.ok, true, JSON.stringify(other));
  ids.investorB = other.id;
  // O investidor antigo (sem tipo gravado) aparece como "Não informado", sem nada ser gravado nele nem classificado pelo documento.
  const before = await one(`select row(v.*)::text from investor v where id = 'inv_old_f'`);
  const legacy = await page(fernando, "/investidores/inv_old_f");
  assert.match(legacy.html, /Tipo de pessoa Não informado \(o documento tem formato de CPF; escolha o tipo ao editar o cadastro\)/);
  assert.equal(await one(`select row(v.*)::text from investor v where id = 'inv_old_f'`), before);
  const profile = await page(robério, `/investidores/${ids.company}`);
  assert.match(profile.html, /Tipo de pessoa Pessoa jurídica/);
  assert.match(profile.html, /Nome fantasia Investe Já/);
  assert.match(profile.html, /Data de abertura 01\/03\/2015/);
});

test("IC1b. contas bancárias: várias por investidor, só o que se aplica, preferencial única, mascaradas e fora da auditoria", async () => {
  const save = (fields, cookie = robério) => action(cookie, "saveInvestorBankAccountAction", { investorId: ids.investor, ...fields });
  assert.match((await save({ bankName: "Banco do Brasil", branch: "1234" }))?.error, /agência e a conta/);
  assert.match((await save({}))?.error, /Informe a conta bancária/);
  const bank = await save({ bankCode: "001", bankName: "Banco do Brasil", branch: "1234", branchDigit: "5", account: "998876", accountDigit: "5", accountType: "SAVINGS", holderName: "Marta Cronograma", holderDocument: "411.797.058-58" });
  assert.equal(bank?.ok, true, JSON.stringify(bank));
  ids.bankAccount = bank.id;
  const pix = await save({ pixKeyType: "PHONE", pixKey: "+55 (11) 91234-5678", isPreferred: "1", notes: "preferência do investidor" });
  assert.equal(pix?.ok, true, JSON.stringify(pix));
  ids.pixAccount = pix.id;
  const rows = await admin(`select id, is_preferred, pix_key, account from investor_bank_account where investor_id = '${ids.investor}' order by created_at`);
  assert.deepEqual(rows.map((row) => [row.id, row.is_preferred]), [[ids.bankAccount, false], [ids.pixAccount, true]], "só uma preferencial");
  assert.equal(rows[1].pix_key, "11912345678");
  // Na ficha tudo aparece mascarado; os números completos só vêm ao pedir para editar.
  const profile = await page(robério, `/investidores/${ids.investor}`);
  assert.match(profile.html, /Contas bancárias/);
  assert.match(profile.html, /•••876-5/);
  assert.ok(!profile.html.includes("998876") && !profile.html.includes("91234-5678") && !profile.html.includes("11912345678"), "número completo não vai para a página");
  const loaded = await action(robério, "loadInvestorBankAccountForEditAction", { accountId: ids.bankAccount });
  assert.equal(loaded?.values?.account, "998876");
  assert.equal((await action(fernando, "loadInvestorBankAccountForEditAction", { accountId: ids.bankAccount }))?.ok, false, "outra carteira não lê a conta");
  assert.equal((await save({ pixKeyType: "EMAIL", pixKey: "x@y.com" }, fernando))?.ok, false, "outra carteira não grava conta no investidor do A");
  assert.equal((await action(fernando, "archiveInvestorBankAccountAction", { investorId: ids.investor, accountId: ids.bankAccount }))?.ok, false);
  const audit = JSON.stringify(await admin(`select before, after from admin_audit_log where entity = 'investor_bank_account'`));
  assert.ok(!audit.includes("998876") && !audit.includes("11912345678") && !audit.includes("41179705858"), "números fora da auditoria");
  assert.ok(audit.includes("Chave Pix"), "a auditoria diz quais campos mudaram");
  // Banco: chave Pix sem tipo e duas preferenciais são recusadas.
  await assert.rejects(admin(`update investor_bank_account set is_preferred = true where id = '${ids.bankAccount}'`));
});

test("IC1c. documentos do investidor: enviar, visualizar, retirar sem apagar; outra carteira recebe 404", async () => {
  const uploaded = await action(robério, "uploadInvestorDocumentAction", { investorId: ids.investor, kind: "IDENTITY", label: "RG" }, { file: [PDF, "application/pdf", "rg.pdf"] });
  assert.equal(uploaded?.ok, true, JSON.stringify(uploaded));
  assert.equal((await action(robério, "uploadInvestorDocumentAction", { investorId: ids.investor, kind: "IDENTITY" }, { file: ["texto", "text/plain", "x.txt"] }))?.ok, false);
  assert.equal((await action(fernando, "uploadInvestorDocumentAction", { investorId: ids.investor, kind: "OTHER" }, { file: [PDF, "application/pdf", "x.pdf"] }))?.ok, false);
  const own = await fetch(`${BASE}/investidores/documentos-investidor/${uploaded.id}`, { headers: { cookie: robério } });
  assert.equal(own.status, 200);
  assert.equal(await own.text(), PDF);
  assert.equal((await fetch(`${BASE}/investidores/documentos-investidor/${uploaded.id}`, { headers: { cookie: fernando } })).status, 404);
  const removed = await action(robério, "removeInvestorDocumentAction", { documentId: uploaded.id });
  assert.equal(removed?.ok, true, JSON.stringify(removed));
  assert.equal(await one(`select (removed_at is not null)::text from investor_document where id = '${uploaded.id}'`), "true", "retirado, não apagado");
  assert.match((await page(robério, `/investidores/${ids.investor}`)).html, /Documentos retirados \(1\)/);
});

test("IC2. contrato: datas, prazo com unidade, forma de pagamento e conta do investidor, condições; identificação única", async () => {
  const base = { investorId: ids.investor, amount: "50.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: "2026-10-10", contractNumber: "INV-2026/001",
    contractedOn: "2026-10-05", investedOn: "2026-10-08", termCount: "12", termUnit: "MONTHS", maturityDate: "2027-10-10", paymentFrequency: "MONTHLY", installmentCount: "12",
    paymentMethod: "PIX", bankAccountId: ids.pixAccount, yieldTerms: "Rendimento mensal até o dia 10", principalTerms: "Devolução integral no vencimento" };
  assert.match((await action(robério, "createInvestmentAction", { ...base, bankAccountId: ids.bankAccount }))?.error, /chave Pix/, "Pix numa conta sem chave");
  assert.equal((await action(robério, "createInvestmentAction", { ...base, bankAccountId: "iba_inexistente" }))?.ok, false);
  const created = await action(robério, "createInvestmentAction", base);
  assert.equal(created?.ok, true, JSON.stringify(created));
  ids.investment = created.id;
  const [row] = await admin(`select contract_number, contracted_on::text, invested_on::text, term_count, term_unit, term_months, payment_frequency, payment_method, bank_account_id, yield_terms, principal_terms, calculation_rule from investment where id = '${ids.investment}'`);
  assert.deepEqual({ ...row }, { contract_number: "INV-2026/001", contracted_on: "2026-10-05", invested_on: "2026-10-08", term_count: 12, term_unit: "MONTHS", term_months: null, payment_frequency: "MONTHLY",
    payment_method: "PIX", bank_account_id: ids.pixAccount, yield_terms: "Rendimento mensal até o dia 10", principal_terms: "Devolução integral no vencimento", calculation_rule: null });
  // Conta de outro investidor (mesmo tenant) é recusada pelo servidor e pelo banco.
  const otherAccount = await action(robério, "saveInvestorBankAccountAction", { investorId: ids.company, pixKeyType: "CNPJ", pixKey: "11.222.333/0001-81" });
  assert.equal((await action(robério, "createInvestmentAction", { ...base, contractNumber: "", bankAccountId: otherAccount.id }))?.ok, false);
  await assert.rejects(admin(`update investment set bank_account_id = '${otherAccount.id}' where id = '${ids.investment}'`));
  // Conta escolhida em contrato: não pode ser retirada nem ter o número trocado.
  assert.match((await action(robério, "archiveInvestorBankAccountAction", { investorId: ids.investor, accountId: ids.pixAccount }))?.error, /contrato em vigor/);
  assert.match((await action(robério, "saveInvestorBankAccountAction", { investorId: ids.investor, accountId: ids.pixAccount, pixKeyType: "PHONE", pixKey: "(11) 90000-0000" }))?.error, /ligada a um contrato/);
  const duplicate = await action(robério, "createInvestmentAction", { investorId: ids.investor, amount: "1.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: "2026-10-10", contractNumber: "INV-2026/001" });
  assert.match(duplicate?.error, /identificação/);
  const otherInvestment = await action(fernando, "createInvestmentAction", { investorId: ids.investorB, amount: "1.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: "2026-10-10", contractNumber: "INV-2026/001" });
  assert.equal(otherInvestment?.ok, true, JSON.stringify(otherInvestment));
  ids.investmentB = otherInvestment.id;
  ids.base = base;
});

test("IC3. alteração do contrato fica no histórico (antes e depois, conta mascarada)", async () => {
  const fields = { ...ids.base };
  delete fields.investorId;
  const updated = await action(robério, "updateInvestmentAction", { investmentId: ids.investment, ...fields, paymentFrequency: "QUARTERLY", installmentCount: "4" });
  assert.equal(updated?.ok, true, JSON.stringify(updated));
  const [revision] = await admin(`select kind, changes from investment_revision where investment_id = '${ids.investment}'`);
  assert.equal(revision.kind, "CONTRACT");
  assert.deepEqual(revision.changes, [
    { field: "Periodicidade dos pagamentos", before: "Mensal", after: "Trimestral" },
    { field: "Quantidade de parcelas", before: "12", after: "4" },
  ]);
  await action(robério, "updateInvestmentAction", { investmentId: ids.investment, ...fields, paymentFrequency: "QUARTERLY", installmentCount: "4" });
  assert.equal(await one(`select count(*)::int from investment_revision where investment_id = '${ids.investment}'`), 1, "salvar sem mudar nada não cria linha");
  await action(robério, "updateInvestmentAction", { investmentId: ids.investment, ...fields, paymentFrequency: "MONTHLY", installmentCount: "12", paymentMethod: "TRANSFER", bankAccountId: ids.bankAccount });
  const [last] = await admin(`select changes from investment_revision where investment_id = '${ids.investment}' order by created_at desc limit 1`);
  const account = last.changes.find((change) => change.field === "Conta bancária para os pagamentos");
  assert.ok(account && account.after.includes("•••876-5") && !JSON.stringify(last.changes).includes("998876"), JSON.stringify(last.changes));
  const detail = await page(robério, `/investidores/investimentos/${ids.investment}`);
  for (const expected of ["Histórico de alterações", "Periodicidade dos pagamentos: de Mensal para Trimestral", "Identificação do contrato INV-2026/001", "Prazo 12 meses", "Data da contratação 05/10/2026",
    "Dinheiro recebido em 08/10/2026", "Forma de pagamento Transferência", "Devolução do principal Devolução integral no vencimento", "Posição do contrato"]) assert.ok(detail.html.includes(expected), `contrato sem "${expected}"`);
});

test("IC4. cronograma revisado: grava exatamente as linhas enviadas, sem duplicar; datas e principal conferidos", async () => {
  const model = monthly("2026-11-10", 12, "750,00", "50.000,00");
  const empty = await version(ids.investment);
  assert.match((await lines(ids.investment, [{ ...model[0], dueDate: "2026-10-01" }], { seen: empty }))?.error, /anterior ao início/);
  assert.match((await lines(ids.investment, [...model.slice(0, 11), { ...model[11], principalAmount: "50.000,01" }], { seen: empty }))?.error, /principal/i);
  const first = await lines(ids.investment, model, { seen: empty });
  assert.equal(first?.ok, true, JSON.stringify(first));
  const saved = await items(ids.investment);
  assert.equal(saved.length, 12);
  assert.deepEqual({ ...saved[11] }, { number: 12, due_date: "2027-10-10", yield_cents: 75_000, principal_cents: 5_000_000, description: "Rendimento mensal" });
  // O mesmo envio de novo (clique repetido): recusado, nada duplica.
  assert.match((await lines(ids.investment, model, { seen: empty }))?.error, /mudou/);
  assert.match((await action(robério, "saveInvestmentScheduleLinesAction", { investmentId: ids.investment, mode: "append", lines: JSON.stringify(model.slice(0, 1)), seen: empty }))?.error, /mudou/, "incluir com a tela desatualizada");
  const seen = await version(ids.investment);
  assert.match((await lines(ids.investment, model, { seen }))?.error, /Confirme/);
  // Dois envios simultâneos confirmando a substituição a partir da mesma tela: só um grava.
  const results = await Promise.all([lines(ids.investment, model, { seen, replace: "1" }), lines(ids.investment, model, { seen, replace: "1" })]);
  assert.deepEqual(results.map((result) => result?.ok).sort(), [false, true], JSON.stringify(results));
  assert.equal((await items(ids.investment)).length, 12);
  assert.equal(await one(`select count(*)::int from investment_revision where investment_id = '${ids.investment}' and kind = 'SCHEDULE'`), 2);
  await assert.rejects(admin(`insert into investment_schedule_item (id, tenant_id, investment_id, number, due_date) values ('ivs_zero', 'ten_roberio', '${ids.investment}', 90, '2027-12-01')`));
  await assert.rejects(admin(`insert into investment_schedule_item (id, tenant_id, investment_id, number, due_date, yield_cents) values ('ivs_dup', 'ten_roberio', '${ids.investment}', 1, '2027-12-01', 1)`));
  await assert.rejects(admin(`insert into investment_schedule_item (id, tenant_id, investment_id, number, due_date, yield_cents) values ('ivs_x', 'ten_fernando', '${ids.investment}', 50, '2027-12-01', 1)`));
});

test("IC5. incluir, editar e retirar um pagamento; cada alteração no histórico e na auditoria", async () => {
  const added = await action(robério, "addInvestmentScheduleItemAction", { investmentId: ids.investment, kind: "YIELD", dueDate: "2027-12-15", yieldAmount: "100,00", description: "Bônus combinado" });
  assert.equal(added?.ok, true, JSON.stringify(added));
  const [extra] = await admin(`select id, number from investment_schedule_item where investment_id = '${ids.investment}' and due_date = '2027-12-15'`);
  assert.equal(extra.number, 13);
  const edited = await action(robério, "updateInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: extra.id, kind: "YIELD", dueDate: "2027-12-20", yieldAmount: "150,00", principalAmount: "" });
  assert.equal(edited?.ok, true, JSON.stringify(edited));
  assert.deepEqual({ ...(await admin(`select due_date::text, yield_cents::int, principal_cents::int, description from investment_schedule_item where id = '${extra.id}'`))[0] },
    { due_date: "2027-12-20", yield_cents: 15_000, principal_cents: 0, description: null });
  assert.equal((await action(robério, "updateInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: extra.id, dueDate: "2027-12-20" }))?.ok, false, "linha sem valor");
  assert.equal((await action(robério, "updateInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: extra.id, kind: "YIELD", dueDate: "2027-12-20", yieldAmount: "1", principalAmount: "1" }))?.ok, false, "tipo diferente dos valores");
  const removed = await action(robério, "deleteInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: extra.id });
  assert.equal(removed?.ok, true);
  assert.equal(await one(`select count(*)::int from investment_schedule_item where investment_id = '${ids.investment}'`), 12);
  const descriptions = (await admin(`select description from investment_revision where investment_id = '${ids.investment}' and kind = 'SCHEDULE' order by created_at`)).map((row) => row.description);
  assert.deepEqual(descriptions.slice(-3), ["Pagamento incluído no cronograma", "Pagamento do cronograma alterado", "Pagamento retirado do cronograma"]);
  assert.equal(await one(`select count(*)::int from admin_audit_log where entity_id = '${ids.investment}' and action = 'INVESTMENT_SCHEDULE_UPDATED' and tenant_id = 'ten_roberio'`), 5);
  const detail = await page(robério, `/investidores/investimentos/${ids.investment}`);
  assert.match(detail.html, /Rendimentos informados R\$ 9\.000,00/);
  assert.match(detail.html, /Devolução de principal informada R\$ 50\.000,00/);
  assert.match(detail.html, /Principal sem data de devolução R\$ 0,00/);
});

test("IC6. isolamento: o tenant B não vê nem altera o cronograma do A, nem com ids forjados", async () => {
  const [item] = await admin(`select id from investment_schedule_item where investment_id = '${ids.investment}' order by number limit 1`);
  const one_line = JSON.stringify([{ kind: "YIELD", dueDate: "2027-01-01", yieldAmount: "1", principalAmount: "" }]);
  assert.equal((await action(fernando, "saveInvestmentScheduleLinesAction", { investmentId: ids.investment, mode: "replace", lines: one_line, replace: "1" }))?.ok, false);
  assert.equal((await action(fernando, "saveInvestmentScheduleLinesAction", { investmentId: ids.investment, mode: "append", lines: one_line }))?.ok, false);
  assert.equal((await action(fernando, "addInvestmentScheduleItemAction", { investmentId: ids.investment, dueDate: "2027-01-01", yieldAmount: "1" }))?.ok, false);
  assert.equal((await action(fernando, "updateInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: item.id, dueDate: "2027-01-01", yieldAmount: "1" }))?.ok, false);
  assert.equal((await action(fernando, "deleteInvestmentScheduleItemAction", { investmentId: ids.investment, itemId: item.id }))?.ok, false);
  assert.equal((await action(fernando, "deleteInvestmentScheduleItemAction", { investmentId: ids.investmentB, itemId: item.id }))?.ok, false);
  assert.equal((await action(fernando, "updateInvestmentAction", { investmentId: ids.investment, amount: "1,00", rate: "1", ratePeriod: "MONTHLY", startDate: "2026-10-10" }))?.ok, false);
  assert.equal((await action(fernando, "renewInvestmentAction", { investmentId: ids.investment, confirm: "1", principalCents: "5000000", amount: "50.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: "2027-10-10" }))?.ok, false);
  assert.equal(await one(`select count(*)::int from investment_schedule_item where investment_id = '${ids.investment}'`), 12);
  assert.notEqual((await page(fernando, `/investidores/investimentos/${ids.investment}`)).status, 200);
  assert.ok(!(await page(fernando, `/investidores/investimentos/${ids.investmentB}`)).html.includes("Rendimento mensal"));
});

test("IC7. MASTER vê e altera o cronograma de qualquer carteira; investimento cancelado fica só para consulta", async () => {
  const master = await page(thais, `/investidores/investimentos/${ids.investment}`);
  assert.equal(master.status, 200);
  assert.match(master.html, /Rendimento mensal/);
  const added = await action(thais, "addInvestmentScheduleItemAction", { investmentId: ids.investmentB, dueDate: "2027-02-01", yieldAmount: "10,00" });
  assert.equal(added?.ok, true, JSON.stringify(added));
  assert.equal(await one(`select tenant_id from investment_schedule_item where investment_id = '${ids.investmentB}'`), "ten_fernando");
  await action(fernando, "updateInvestmentAction", { investmentId: ids.investmentB, amount: "1.000,00", rate: "1", ratePeriod: "MONTHLY", startDate: "2026-10-10", contractNumber: "INV-2026/001", status: "CANCELED" });
  const blocked = await action(fernando, "addInvestmentScheduleItemAction", { investmentId: ids.investmentB, dueDate: "2027-03-01", yieldAmount: "10,00" });
  assert.equal(blocked?.ok, false);
  assert.match(blocked.error, /encerrado ou cancelado/);
});

test("IC8. tela: modelo padrão e negociação personalizada (50% do principal no 6º mês, 50% no 12º, data irregular), desktop e celular", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const create = async (contractNumber) => {
      const created = await action(robério, "createInvestmentAction", { investorId: ids.investor, amount: "100.000,00", rate: "5", ratePeriod: "MONTHLY", startDate: "2026-11-01", termCount: "12", termUnit: "MONTHS", paymentFrequency: "MONTHLY", contractNumber });
      assert.equal(created?.ok, true, JSON.stringify(created));
      return created.id;
    };
    const standard = await create(`PADRAO-${label}`);
    const custom = await create(`PERSONALIZADO-${label}`);
    const context = await browser.newContext({ viewport });
    const [name, value] = robério.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
    await context.addCookies([{ name, value, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    const browserPage = await context.newPage();

    // Modelo padrão: rendimento mensal digitado, principal integral na última data; revisão antes de gravar.
    await browserPage.goto(`${BASE}/investidores/investimentos/${standard}`);
    let schedule = browserPage.getByRole("region", { name: "Cronograma de pagamentos ao investidor" });
    await schedule.getByRole("button", { name: "Montar cronograma" }).click();
    await schedule.getByRole("button", { name: "Usar modelo padrão" }).click();
    await schedule.getByText("Digite o rendimento combinado de cada data").waitFor();
    assert.equal(await one(`select count(*)::int from investment_schedule_item where investment_id = '${standard}'`), 0, "o modelo não grava sozinho");
    await schedule.getByLabel("Rendimento de cada data (R$)").fill("5.000,00");
    await schedule.getByRole("button", { name: "Usar modelo padrão" }).click();
    const review = schedule.getByRole("table", { name: "Linhas para revisar" });
    await review.waitFor();
    assert.equal(await review.locator("tbody tr").count(), 12);
    assert.equal(await review.getByLabel("Vencimento da linha 1", { exact: true }).inputValue(), "2026-12-01");
    assert.equal(await review.getByLabel("Principal da linha 12", { exact: true }).inputValue(), "100.000,00");
    if (SHOTS) await schedule.screenshot({ path: `${SHOTS}/modelo-padrao-revisao-${label}.png` });
    await schedule.getByRole("button", { name: "Gravar cronograma revisado" }).click();
    // Gravado, a revisão fecha e a tabela do cronograma aparece com as linhas.
    await browserPage.getByRole("table", { name: "Linhas do cronograma" }).locator("tbody tr").nth(11).waitFor();
    const standardRows = await items(standard);
    assert.equal(standardRows.length, 12);
    assert.deepEqual({ ...standardRows[11] }, { number: 12, due_date: "2027-11-01", yield_cents: 500_000, principal_cents: 10_000_000, description: null });
    assert.ok(standardRows.slice(0, 11).every((row) => row.yield_cents === 500_000 && row.principal_cents === 0));

    // Negociação personalizada: rendimentos mensais em obrigações próprias, 50% do principal no 6º mês e 50% no 12º, e
    // um rendimento com data irregular. Tudo pela tela.
    await browserPage.goto(`${BASE}/investidores/investimentos/${custom}`);
    schedule = browserPage.getByRole("region", { name: "Cronograma de pagamentos ao investidor" });
    await schedule.getByRole("button", { name: "Montar cronograma" }).click();
    await schedule.getByLabel("Data do primeiro pagamento").fill("01/12/2026");
    await schedule.getByLabel("Data do primeiro pagamento").press("Tab");
    await schedule.getByLabel("Quantidade de pagamentos").fill("12");
    await schedule.getByLabel("Rendimento de cada data (R$)").fill("5.000,00");
    await schedule.getByRole("button", { name: "Sugerir linhas para revisar" }).click();
    const editor = schedule.getByRole("table", { name: "Linhas para revisar" });
    await editor.waitFor();
    for (const row of [7, 8, 9, 10, 11, 12]) await editor.getByLabel(`Rendimento da linha ${row}`, { exact: true }).fill("2.500,00");
    await editor.getByLabel("Vencimento da linha 3", { exact: true }).fill("2027-02-20");
    for (const [row, date] of [[13, "2027-05-01"], [14, "2027-11-01"]]) {
      await schedule.getByRole("button", { name: "Linha em branco" }).click();
      await editor.getByLabel(`Vencimento da linha ${row}`, { exact: true }).fill(date);
      await editor.getByLabel(`Tipo da linha ${row}`, { exact: true }).selectOption("PRINCIPAL");
      await editor.getByLabel(`Principal da linha ${row}`, { exact: true }).fill("50.000,00");
      await editor.getByLabel(`Observação da linha ${row}`, { exact: true }).fill("50% do principal");
    }
    await schedule.getByText("rendimento R$ 45.000,00 e devolução de principal R$ 100.000,00").waitFor();
    if (SHOTS) await schedule.screenshot({ path: `${SHOTS}/personalizado-revisao-${label}.png` });
    await schedule.getByRole("button", { name: "Gravar cronograma revisado" }).click();
    // Gravado, a revisão fecha e a tabela do cronograma aparece com as linhas.
    await browserPage.getByRole("table", { name: "Linhas do cronograma" }).locator("tbody tr").nth(13).waitFor();
    const customRows = await items(custom);
    assert.equal(customRows.length, 14);
    assert.deepEqual(customRows.filter((row) => row.principal_cents).map((row) => [row.due_date, row.yield_cents, row.principal_cents, row.description]),
      [["2027-05-01", 0, 5_000_000, "50% do principal"], ["2027-11-01", 0, 5_000_000, "50% do principal"]]);
    assert.ok(customRows.some((row) => row.due_date === "2027-02-20" && row.yield_cents === 500_000), "data irregular gravada como digitada");
    assert.equal(customRows.reduce((total, row) => total + row.yield_cents, 0), 4_500_000);
    await browserPage.reload();
    const position = browserPage.getByRole("region", { name: "Posição do contrato" });
    await position.getByText("Principal restante").waitFor();
    const positionText = text(await position.innerHTML());
    for (const expected of ["Principal contratado R$ 100.000,00", "Principal devolvido R$ 0,00", "Principal restante R$ 100.000,00", "Rendimentos previstos R$ 45.000,00", "Principal sem data de devolução R$ 0,00", "Total das obrigações R$ 145.000,00", "Obrigações pendentes 14"]) {
      assert.ok(positionText.includes(expected), `painel sem "${expected}": ${positionText}`);
    }
    const table = text(await browserPage.getByRole("table", { name: "Linhas do cronograma" }).innerHTML());
    assert.match(table, /Devolução de principal/);
    assert.match(table, /Prevista/);
    if (SHOTS) {
      await position.screenshot({ path: `${SHOTS}/personalizado-painel-${label}.png` });
      await browserPage.getByRole("region", { name: "Cronograma de pagamentos ao investidor" }).screenshot({ path: `${SHOTS}/personalizado-cronograma-${label}.png` });
    }
    assert.equal(await browserPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sem rolagem horizontal (${label})`);
    await browserPage.goto(`${BASE}/investidores/${ids.investor}`);
    const accounts = browserPage.getByRole("region", { name: "Contas bancárias" });
    await accounts.getByText("•••876-5").first().waitFor();
    if (SHOTS) await accounts.screenshot({ path: `${SHOTS}/contas-bancarias-${label}.png` });
    assert.equal(await browserPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `ficha sem rolagem horizontal (${label})`);
    await context.close();
  }
  // Investidor antigo (sem tipo gravado): a edição abre com o tipo em branco e não grava sem a escolha explícita.
  const legacyContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const [legacyName, legacyValue] = fernando.split("; ").find((cookie) => cookie.includes("session_token")).split(/=(.*)/s);
  await legacyContext.addCookies([{ name: legacyName, value: legacyValue, domain: new URL(BASE).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
  const legacyPage = await legacyContext.newPage();
  const before = await one(`select row(v.*)::text from investor v where id = 'inv_old_f'`);
  await legacyPage.goto(`${BASE}/investidores/inv_old_f`);
  await legacyPage.getByRole("button", { name: "Editar", exact: true }).click();
  const form = legacyPage.getByRole("region", { name: "Editar investidor" });
  assert.equal(await form.getByLabel("Tipo de pessoa").inputValue(), "", "tipo não vem preenchido pelo documento");
  await form.getByRole("button", { name: "Salvar alterações" }).click();
  await legacyPage.waitForTimeout(1_000);
  assert.equal(await one(`select row(v.*)::text from investor v where id = 'inv_old_f'`), before, "nada gravado sem escolher o tipo");
  if (SHOTS) await form.screenshot({ path: `${SHOTS}/investidor-antigo-edicao.png` });
  await legacyContext.close();
});

test("IC9. nada fora do módulo mudou: operações, pagamentos, capital, carteiras, clientes, tenants e usuários", async () => {
  assert.equal(await protectedHash(), hashBefore);
});
