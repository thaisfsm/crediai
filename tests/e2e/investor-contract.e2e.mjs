// Contrato de investimento gerado pelo sistema, de ponta a ponta (HTTP + banco): dados obrigatórios, geração do PDF,
// visualizar e baixar, versões, marcação de envio, vínculo com o contrato assinado, preservação do assinado ao gerar nova
// versão, isolamento entre tenants, visão do MASTER, auditoria sem dados sensíveis e o fluxo atual de documentos.
// SÓ em ambiente LOCAL e DESCARTÁVEL (ver tests/e2e/README.md), com os dados fictícios ten_roberio (A), ten_fernando (B)
// e ten_thais (MASTER). Rodar com o servidor usando um papel COM BYPASSRLS (como a produção) e, de novo, sem ele.
//   E2E_DATABASE_URL=postgres://dono:senha@127.0.0.1:5432/crediai node --test tests/e2e/investor-contract.e2e.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { pdfPages, pdfText } from "../helpers/pdf-text.mjs";

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
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
  return { status: response.status, html: response.status === 200 ? text(await response.text()) : "" };
};
const file = async (cookie, path) => {
  const response = await fetch(`${BASE}${path}`, { headers: { cookie } });
  return { status: response.status, headers: response.headers, bytes: response.status === 200 ? new Uint8Array(await response.arrayBuffer()) : null };
};
// O que o contrato não pode tocar: dados financeiros, assinaturas, tenants, usuários e o investimento antigo do Fernando.
const protectedHash = () => one(`select md5(string_agg(x, '|' order by x)) from (
  select 'o'||row(o.*)::text x from loan_operation o union all select 'p'||row(p.*)::text from payment p union all select 'w'||row(w.*)::text from wallet w
  union all select 's'||row(s.*)::text from subscription s union all select 't'||row(t.*)::text from tenant t
  union all select 'u'||concat_ws(',', u.id, u.name, u.email, u.role, u.tenant_id, u.active) from "user" u union all select 'c'||row(c.*)::text from client c
  union all select 'i'||row(i.*)::text from investment i where i.id = 'ivt_old_f'
  union all select 'd'||concat_ws(',', d.id, d.kind, d.contract_id, d.replaced_at, md5(d.content)) from investment_document d where d.id = 'idoc_old_f') t`);
const SIGNED = "%PDF-1.4 contrato assinado pelo investidor";
const ADDRESS = { addressCep: "01310-100", addressStreet: "Avenida Paulista", addressNumber: "1000", addressComplement: "Sala 12", addressDistrict: "Bela Vista", addressCity: "São Paulo", addressState: "SP" };

let robério, fernando, thais, hashBefore;
const ids = {};

test("preparação: investidor e investimento do Robério, sem endereço e sem empresa contratante", async () => {
  hashBefore = await protectedHash();
  robério = await login("roberio@teste.local");
  fernando = await login("fernando@teste.local");
  thais = await login("thais@teste.local");
  const investor = await action(robério, "createInvestorAction", { name: "João Conceição Araújo", document: "411.797.058-58" });
  assert.equal(investor?.ok, true, JSON.stringify(investor));
  ids.investor = investor.id;
  const investment = await action(robério, "createInvestmentAction", { investorId: ids.investor, amount: "50.000,50", rate: "1,5", ratePeriod: "MONTHLY", startDate: "2026-10-13", maturityDate: "2027-10-13", dueDay: "10", notes: "Rendimentos por PIX até o dia 10.", status: "PENDING_SIGNATURE" });
  assert.equal(investment?.ok, true, JSON.stringify(investment));
  ids.investment = investment.id;
});

test("K1. sem dados obrigatórios: a página lista o que falta e a geração é recusada", async () => {
  const view = await page(robério, `/investidores/investimentos/${ids.investment}`);
  assert.equal(view.status, 200);
  assert.match(view.html, /Contrato para assinatura/);
  assert.match(view.html, /Para gerar a versão final do contrato, falta:/);
  assert.match(view.html, /Empresa contratante: razão social/);
  assert.match(view.html, /Investidor: endereço completo/);
  const refused = await action(robério, "generateContractAction", { investmentId: ids.investment });
  assert.equal(refused?.ok, false);
  assert.match(refused.error, /Falta: .*Empresa contratante: razão social.*Investidor: endereço completo/);
  assert.equal(await one(`select count(*)::int from investment_contract`), 0, "nada é gerado");
});

test("K2. empresa contratante: rascunho não libera; confirmação exige dados completos; tenant vem do investimento", async () => {
  const draft = await action(robério, "saveContractorAction", { investmentId: ids.investment, legalName: "Robério Gestão de Crédito Ltda.", document: "12.345.678/0001-90", ...ADDRESS });
  assert.equal(draft?.ok, true, JSON.stringify(draft));
  assert.equal(await one(`select count(*)::int from investment_contractor where tenant_id = 'ten_roberio' and confirmed_at is null`), 1);
  const stillBlocked = await action(robério, "generateContractAction", { investmentId: ids.investment });
  assert.match(stillBlocked.error, /Empresa contratante: confirmação dos dados/);
  const incomplete = await action(robério, "saveContractorAction", { investmentId: ids.investment, legalName: "Robério Gestão de Crédito Ltda.", confirmed: "1" });
  assert.equal(incomplete?.ok, false);
  const confirmed = await action(robério, "saveContractorAction", { investmentId: ids.investment, legalName: "Robério Gestão de Crédito Ltda.", document: "12.345.678/0001-90", representativeName: "Robério Santos", representativeDocument: "529.982.247-25", ...ADDRESS, confirmed: "1" });
  assert.equal(confirmed?.ok, true, JSON.stringify(confirmed));
  const [row] = await admin(`select * from investment_contractor where tenant_id = 'ten_roberio'`);
  assert.ok(row.confirmed_at && row.confirmed_by_user_id === "u_roberio");
  assert.equal(row.document, "12345678000190");
  assert.equal(row.address_cep, "01310100");
  // O endereço do investidor é o que ainda falta.
  const blocked = await action(robério, "generateContractAction", { investmentId: ids.investment, includeNotes: "1" });
  assert.match(blocked.error, /Investidor: endereço completo/);
  assert.doesNotMatch(blocked.error, /Empresa contratante/);
  const investor = await action(robério, "updateInvestorAction", { investorId: ids.investor, name: "João Conceição Araújo", document: "411.797.058-58", status: "ACTIVE", ...ADDRESS, addressStreet: "Rua São João", addressNumber: "45", addressComplement: "", addressDistrict: "Centro", addressCity: "Ribeirão Preto" });
  assert.equal(investor?.ok, true, JSON.stringify(investor));
});

test("K3. gerar contrato: versão 1 vinculada ao investimento, PDF com os dados corretos e auditoria sem dados pessoais", async () => {
  const generated = await action(robério, "generateContractAction", { investmentId: ids.investment, includeNotes: "1" });
  assert.equal(generated?.ok, true, JSON.stringify(generated));
  ids.v1 = generated.id;
  const [row] = await admin(`select * from investment_contract where id = '${ids.v1}'`);
  assert.equal(row.tenant_id, "ten_roberio");
  assert.equal(row.investment_id, ids.investment);
  assert.equal(row.version, 1);
  assert.equal(row.includes_notes, true);
  assert.equal(row.sent_at, null);
  assert.equal(row.superseded_at, null);
  assert.equal(row.file_name, "contrato-investimento-joao-conceicao-araujo-v1.pdf");
  assert.equal(row.sha256, sha(row.content));
  const content = pdfText(row.content).replace(/\s+/g, " ");
  for (const expected of ["Robério Gestão de Crédito Ltda., CNPJ nº 12.345.678/0001-90", "representante legal: Robério Santos, CPF nº 529.982.247-25", "João Conceição Araújo, CPF nº 411.797.058-58",
    "Rua São João, 45, Centro, Ribeirão Preto/SP, CEP 01310-100", "R$ 50.000,50 (cinquenta mil reais e cinquenta centavos)", "1,5% ao mês", "Data de início: 13/10/2026",
    "Vencimento do contrato: 13/10/2027", "Dia de vencimento combinado: dia 10", "Rendimentos por PIX até o dia 10.", "São Paulo/SP, ____ de", "Versão 1", "Documento sem assinaturas"]) {
    assert.ok(content.includes(expected), `PDF sem "${expected}"`);
  }
  // O status do investimento não muda: gerar não é assinar.
  assert.equal(await one(`select status from investment where id = '${ids.investment}'`), "PENDING_SIGNATURE");
  const [audit] = await admin(`select * from admin_audit_log where entity = 'investment_contract' and entity_id = '${ids.v1}'`);
  assert.equal(audit.action, "INVESTMENT_CONTRACT_GENERATED");
  assert.equal(audit.tenant_id, "ten_roberio");
  assert.equal(audit.actor_email, "roberio@teste.local");
  assert.equal(audit.after.version, 1);
  assert.equal(audit.after.sha256, row.sha256);
  const logged = JSON.stringify(audit);
  for (const sensitive of ["41179705858", "411.797.058-58", "Rua São João", "PIX", "%PDF"]) assert.ok(!logged.includes(sensitive), `auditoria não pode ter "${sensitive}"`);
  // O endereço do investidor também não vai por extenso na auditoria da edição.
  const [investorAudit] = await admin(`select after from admin_audit_log where action = 'INVESTOR_UPDATED' and entity_id = '${ids.investor}' order by created_at desc limit 1`);
  assert.equal(investorAudit.after.address, "preenchido (Ribeirão Preto/SP)");
  assert.ok(!JSON.stringify(investorAudit).includes("Rua São João"));
});

test("K4. visualizar e baixar o PDF; página mostra a versão e o estado", async () => {
  const inline = await file(robério, `/investidores/contratos/${ids.v1}`);
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get("content-type"), "application/pdf");
  assert.match(inline.headers.get("content-disposition"), /^inline; filename\*=UTF-8''contrato-investimento-joao-conceicao-araujo-v1\.pdf$/);
  assert.equal(inline.headers.get("cache-control"), "private, no-store");
  const download = await file(robério, `/investidores/contratos/${ids.v1}?baixar=1`);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  assert.equal(sha(download.bytes), await one(`select sha256 from investment_contract where id = '${ids.v1}'`));
  assert.ok(pdfPages(download.bytes).at(-1).includes("TESTEMUNHAS"));
  const view = await page(robério, `/investidores/investimentos/${ids.investment}`);
  assert.match(view.html, /Contrato gerado · versão 1/);
  assert.match(view.html, /Gerado, ainda não enviado/);
  assert.match(view.html, /Baixar PDF/);
  assert.doesNotMatch(view.html, /Para gerar a versão final do contrato, falta/);
});

test("K5. sem alteração não gera versão repetida; marcar como enviado registra o estado e a auditoria", async () => {
  const same = await action(robério, "generateContractAction", { investmentId: ids.investment, includeNotes: "1" });
  assert.equal(same?.ok, false);
  assert.match(same.error, /não mudaram desde a versão 1/);
  const sent = await action(robério, "markContractSentAction", { contractId: ids.v1 });
  assert.equal(sent?.ok, true, JSON.stringify(sent));
  assert.equal(await one(`select sent_by_user_id from investment_contract where id = '${ids.v1}'`), "u_roberio");
  assert.equal((await action(robério, "markContractSentAction", { contractId: ids.v1 }))?.ok, false, "não marca duas vezes");
  assert.equal(await one(`select count(*)::int from admin_audit_log where action = 'INVESTMENT_CONTRACT_SENT' and entity_id = '${ids.v1}'`), 1);
  assert.match((await page(robério, `/investidores/investimentos/${ids.investment}`)).html, /Enviado para assinatura/);
});

test("K6. anexar o contrato assinado indicando a versão gerada que foi assinada", async () => {
  const uploaded = await action(robério, "uploadInvestmentDocumentAction", { investmentId: ids.investment, kind: "SIGNED_CONTRACT", contractId: ids.v1 }, { file: [SIGNED, "application/pdf", "contrato-assinado.pdf"] });
  assert.equal(uploaded?.ok, true, JSON.stringify(uploaded));
  ids.signed = uploaded.id;
  const [row] = await admin(`select contract_id, kind, md5(content) as hash from investment_document where id = '${ids.signed}'`);
  assert.equal(row.contract_id, ids.v1);
  ids.signedHash = row.hash;
  const [audit] = await admin(`select after, description from admin_audit_log where entity_id = '${ids.signed}'`);
  assert.equal(audit.after.contractVersion, 1);
  assert.match(audit.description, /assinatura da versão 1 do contrato gerado/);
  const view = await page(robério, `/investidores/investimentos/${ids.investment}`);
  assert.match(view.html, /Assinado \(documento anexado\)/);
  assert.match(view.html, /assinatura da versão 1 do contrato gerado/);
  // Versão de outro investimento não é aceita como versão assinada.
  const other = await action(robério, "createInvestmentAction", { investorId: ids.investor, amount: "1.000,00", rate: "1", ratePeriod: "YEARLY", startDate: "2026-10-13", maturityDate: "2026-12-13" });
  ids.otherInvestment = other.id;
  const wrong = await action(robério, "uploadInvestmentDocumentAction", { investmentId: ids.otherInvestment, kind: "SIGNED_CONTRACT", contractId: ids.v1 }, { file: [SIGNED, "application/pdf", "x.pdf"] });
  assert.equal(wrong?.ok, false);
  assert.equal(await one(`select count(*)::int from investment_document where investment_id = '${ids.otherInvestment}'`), 0);
});

test("K7. dados alterados: nova versão só com confirmação, o assinado é preservado e o histórico fica completo", async () => {
  const updated = await action(robério, "updateInvestmentAction", { investmentId: ids.investment, amount: "60.000,00", rate: "1,5", ratePeriod: "MONTHLY", startDate: "2026-10-13", maturityDate: "2027-10-13", dueDay: "10", notes: "Rendimentos por PIX até o dia 10.", status: "PENDING_SIGNATURE" });
  assert.equal(updated?.ok, true);
  assert.match((await page(robério, `/investidores/investimentos/${ids.investment}`)).html, /Os dados do contrato mudaram desde a versão 1/);
  const unconfirmed = await action(robério, "generateContractAction", { investmentId: ids.investment, includeNotes: "1" });
  assert.equal(unconfirmed?.ok, false);
  assert.match(unconfirmed.error, /já tem contrato assinado/);
  // Duas gerações ao mesmo tempo: uma só versão nova, sem duplicata.
  const results = await Promise.all([1, 2].map(() => action(robério, "generateContractAction", { investmentId: ids.investment, includeNotes: "1", confirmSignedKept: "1" })));
  assert.equal(results.filter((result) => result?.ok).length, 1, JSON.stringify(results));
  ids.v2 = results.find((result) => result?.ok).id;
  const versions = await admin(`select id, version, superseded_at, superseded_by_contract_id, sent_at from investment_contract where investment_id = '${ids.investment}' order by version`);
  assert.deepEqual(versions.map((row) => row.version), [1, 2]);
  assert.equal(versions[0].superseded_by_contract_id, ids.v2);
  assert.ok(versions[0].superseded_at && versions[0].sent_at, "a v1 continua com o registro de envio");
  assert.equal(versions[1].superseded_at, null);
  // O contrato assinado não foi tocado: mesmo id, mesmo conteúdo, vigente e ligado à versão 1.
  const [signed] = await admin(`select contract_id, replaced_at, md5(content) as hash from investment_document where id = '${ids.signed}'`);
  assert.deepEqual([signed.contract_id, signed.replaced_at, signed.hash], [ids.v1, null, ids.signedHash]);
  assert.match(pdfText(await one(`select content from investment_contract where id = '${ids.v2}'`)).replace(/\s+/g, " "), /R\$ 60\.000,00 \(sessenta mil reais\)/);
  // A versão 1 continua disponível para visualizar e baixar.
  assert.equal((await file(robério, `/investidores/contratos/${ids.v1}?baixar=1`)).status, 200);
  assert.equal((await action(robério, "markContractSentAction", { contractId: ids.v1 }))?.ok, false, "versão substituída não é marcada como enviada");
  const view = await page(robério, `/investidores/investimentos/${ids.investment}`);
  assert.match(view.html, /Contrato gerado · versão 2 \(nova versão\)/);
  assert.match(view.html, /Gerado, ainda não enviado/);
  assert.match(view.html, /Assinado \(documento anexado\)/, "a v1 continua identificada como a versão assinada");
  const [audit] = await admin(`select before, after, description from admin_audit_log where entity_id = '${ids.v2}'`);
  assert.equal(audit.before.version, 1);
  assert.equal(audit.after.signedContractKept, true);
  // Substituir o assinado: a nova versão do arquivo mantém o vínculo, e a anterior fica no histórico.
  const replaced = await action(robério, "replaceInvestmentDocumentAction", { documentId: ids.signed, contractId: ids.v2 }, { file: [`${SIGNED} v2`, "application/pdf", "assinado-v2.pdf"] });
  assert.equal(replaced?.ok, true, JSON.stringify(replaced));
  assert.equal(await one(`select contract_id from investment_document where id = '${replaced.id}'`), ids.v2);
  assert.equal(await one(`select contract_id from investment_document where id = '${ids.signed}'`), ids.v1);
  assert.ok(await one(`select replaced_at is not null from investment_document where id = '${ids.signed}'`));
});

test("K8. isolamento: outro tenant não vê, não gera, não marca e não grava empresa contratante pelo investimento alheio", async () => {
  for (const path of [`/investidores/contratos/${ids.v1}`, `/investidores/contratos/${ids.v2}?baixar=1`, `/investidores/investimentos/${ids.investment}`]) {
    assert.equal((await page(fernando, path)).status, 404, path);
  }
  assert.match((await action(fernando, "generateContractAction", { investmentId: ids.investment, confirmSignedKept: "1", includeNotes: "1" }))?.error ?? "", /não encontrado/);
  assert.match((await action(fernando, "markContractSentAction", { contractId: ids.v2 }))?.error ?? "", /não encontrado/);
  assert.match((await action(fernando, "saveContractorAction", { investmentId: ids.investment, legalName: "Invasor Ltda", document: "11.222.333/0001-81" }))?.error ?? "", /não encontrado/);
  assert.equal(await one(`select count(*)::int from investment_contractor where tenant_id = 'ten_fernando'`), 0);
  assert.equal(await one(`select legal_name from investment_contractor where tenant_id = 'ten_roberio'`), "Robério Gestão de Crédito Ltda.");
  // Contrato assinado no investimento do próprio Fernando apontando para a versão do Robério: recusado.
  const forged = await action(fernando, "uploadInvestmentDocumentAction", { investmentId: "ivt_old_f", kind: "ADDENDUM", contractId: ids.v1 }, { file: [SIGNED, "application/pdf", "a.pdf"] });
  assert.equal(forged?.ok, true, "aditivo não usa versão: o campo é ignorado");
  assert.equal(await one(`select contract_id from investment_document where id = '${forged.id}'`), null);
  ids.fernandoAddendum = forged.id;
  const replaceForged = await action(fernando, "replaceInvestmentDocumentAction", { documentId: "idoc_old_f", contractId: ids.v1 }, { file: [SIGNED, "application/pdf", "b.pdf"] });
  assert.equal(replaceForged?.ok, false);
  // Ids inválidos ou forjados: 404, sem erro do servidor.
  for (const bad of ["..%2F..%2Fetc", "ictr_inexistente", "x'%20or%201=1--"]) assert.equal((await file(fernando, `/investidores/contratos/${bad}`)).status, 404, bad);
  assert.equal(await one(`select count(*)::int from admin_audit_log where tenant_id = 'ten_roberio' and actor_email = 'fernando@teste.local'`), 0);
});

test("K9. MASTER vê, baixa e gera contrato de qualquer carteira; os dados vão para a carteira do investimento", async () => {
  assert.equal((await file(thais, `/investidores/contratos/${ids.v2}`)).status, 200);
  const view = await page(thais, `/investidores/investimentos/${ids.investment}`);
  assert.match(view.html, /Robério Gestão de Crédito Ltda\./);
  const saved = await action(thais, "saveContractorAction", { investmentId: ids.investment, legalName: "Robério Gestão de Crédito Ltda.", document: "12.345.678/0001-90", representativeName: "Robério Santos", representativeDocument: "529.982.247-25", ...ADDRESS, addressNumber: "1001", confirmed: "1" });
  assert.equal(saved?.ok, true, JSON.stringify(saved));
  assert.equal(await one(`select address_number from investment_contractor where tenant_id = 'ten_roberio'`), "1001");
  assert.equal(await one(`select count(*)::int from investment_contractor where tenant_id = 'ten_thais'`), 0);
  const generated = await action(thais, "generateContractAction", { investmentId: ids.investment, includeNotes: "1", confirmSignedKept: "1" });
  assert.equal(generated?.ok, true, JSON.stringify(generated));
  const [row] = await admin(`select tenant_id, version, generated_by_user_id from investment_contract where id = '${generated.id}'`);
  assert.deepEqual([row.tenant_id, row.version, row.generated_by_user_id], ["ten_roberio", 3, "u_thais"]);
});

test("K10. período 'outro' só gera com as observações no contrato; investimento cancelado não gera", async () => {
  const other = await action(robério, "updateInvestmentAction", { investmentId: ids.otherInvestment, amount: "1.000,00", rate: "3", ratePeriod: "OTHER", startDate: "2026-10-13", maturityDate: "2026-12-13", notes: "3% ao trimestre." });
  assert.equal(other?.ok, true);
  assert.match((await action(robério, "generateContractAction", { investmentId: ids.otherInvestment }))?.error ?? "", /período da taxa "outro"/);
  const withNotes = await action(robério, "generateContractAction", { investmentId: ids.otherInvestment, includeNotes: "1" });
  assert.equal(withNotes?.ok, true, JSON.stringify(withNotes));
  assert.match(pdfText(await one(`select content from investment_contract where id = '${withNotes.id}'`)).replace(/\s+/g, " "), /3%, no período descrito nas condições adicionais deste instrumento.*3% ao trimestre\./);
  await action(robério, "updateInvestmentAction", { investmentId: ids.otherInvestment, amount: "1.000,00", rate: "3", ratePeriod: "OTHER", startDate: "2026-10-13", maturityDate: "2026-12-13", notes: "3% ao trimestre.", status: "CANCELED" });
  assert.match((await action(robério, "generateContractAction", { investmentId: ids.otherInvestment, includeNotes: "1" }))?.error ?? "", /cancelado/);
});

test("K11. fluxo atual de documentos continua: enviar, visualizar, baixar e substituir um aditivo", async () => {
  const uploaded = await action(robério, "uploadInvestmentDocumentAction", { investmentId: ids.investment, kind: "ADDENDUM" }, { file: ["%PDF-1.4 aditivo", "application/pdf", "aditivo.pdf"] });
  assert.equal(uploaded?.ok, true);
  assert.equal((await file(robério, `/investidores/documentos/${uploaded.id}`)).status, 200);
  assert.match((await file(robério, `/investidores/documentos/${uploaded.id}?baixar=1`)).headers.get("content-disposition"), /^attachment;/);
  const replaced = await action(robério, "replaceInvestmentDocumentAction", { documentId: uploaded.id }, { file: ["%PDF-1.4 aditivo v2", "application/pdf", "aditivo-v2.pdf"] });
  assert.equal(replaced?.ok, true);
  assert.equal(await one(`select contract_id from investment_document where id = '${replaced.id}'`), null);
  assert.equal((await action(robério, "uploadInvestmentDocumentAction", { investmentId: ids.investment, kind: "SIGNED_CONTRACT" }, { file: [SIGNED, "application/pdf", "dup.pdf"] }))?.ok, false, "segue havendo um só contrato assinado vigente");
});

test("K12. nada fora do módulo mudou (operações, pagamentos, carteiras, assinaturas, tenants, usuários, clientes)", async () => {
  assert.equal(await protectedHash(), hashBefore);
  await sql.end();
});
