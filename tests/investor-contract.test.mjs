// Contrato de investimento gerado pelo sistema: texto, dados obrigatórios, valores por extenso, PDF (acentos, moeda,
// paginação) e a migration 0016. Não usa banco.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addressFields, addressLine } from "../src/lib/investors/address.ts";
import {
  CONTRACT_TEMPLATE_VERSION, buildContract, contractFileName, contractFingerprint, contractRateText, contractState, contractorFields, integerInWords,
  missingContractData, moneyInWords,
} from "../src/lib/investors/contract.ts";
import { renderContractPdf } from "../src/lib/investors/contract-pdf.ts";
import { investorFields } from "../src/lib/investors/rules.ts";
import { pdfPages, pdfText } from "./helpers/pdf-text.mjs";

const form = (values) => (key, max) => String(values[key] ?? "").trim().slice(0, max);
const font = (style) => readFileSync(`src/lib/investors/fonts/LiberationSans-${style}.ttf`);
const fonts = { regular: font("Regular"), bold: font("Bold"), italic: font("Italic") };
const address = (overrides = {}) => ({ Cep: "01310100", Street: "Avenida Paulista", Number: "1000", Complement: "Sala 12", District: "Bela Vista", City: "São Paulo", State: "SP", ...overrides });
const source = (overrides = {}) => ({
  contractor: { legalName: "Gestão de Crédito Ação Ltda.", document: "11222333000181", address: address(), representativeName: "Thaís Fernanda", representativeDocument: "41179705858", confirmedAt: "2026-10-13T12:00:00.000Z", ...overrides.contractor },
  investor: { name: "João Conceição Araújo", document: "41179705858", address: address({ Street: "Rua São João", Number: "45", Complement: null, District: "Centro", City: "Ribeirão Preto" }), ...overrides.investor },
  investment: { id: "ivt_teste", amountCents: 5_000_050, agreedRateBps: 150, ratePeriod: "MONTHLY", startDate: "2026-10-13", maturityDate: "2027-10-13", dueDay: 10, notes: null, status: "ACTIVE", paymentFrequency: "MONTHLY", yieldPaymentCents: 50_000, redemptionRule: "AT_MATURITY", redemptionDays: null, ...overrides.investment },
});
const generatedAt = new Date("2026-10-13T13:05:00Z");
const render = async (data, includeNotes = false, version = 1) => renderContractPdf(buildContract(data, includeNotes, { version, generatedAt }), generatedAt, fonts);

test("CT1. PDF com os dados corretos: partes, valor, taxa e período, datas, local e assinaturas", async () => {
  const bytes = await render(source(), false, 2);
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString("latin1"), "%PDF-");
  const text = pdfText(bytes);
  for (const expected of [
    "INSTRUMENTO PARTICULAR DE CONTRATO DE INVESTIMENTO", "Versão 2 · Referência do investimento ivt_teste",
    "CONTRATANTE: Gestão de Crédito Ação Ltda., CNPJ nº 11.222.333/0001-81", "Avenida Paulista, 1000, Sala 12, Bela Vista, São Paulo/SP, CEP 01310-100",
    "representante legal:", "Thaís Fernanda, CPF nº 411.797.058-58",
    "INVESTIDOR: João Conceição Araújo, CPF nº 411.797.058-58", "Rua São João,", "45, Centro, Ribeirão Preto/SP, CEP 01310-100",
    "R$ 50.000,50 (cinquenta mil reais e cinquenta centavos)", "1,5% ao mês", "Data de início: 13/10/2026", "Vencimento do contrato: 13/10/2027",
    "Dia de vencimento combinado: dia 10", "São Paulo/SP, ____ de", "CONTRATANTE", "INVESTIDOR", "TESTEMUNHAS", "Testemunha 1", "Testemunha 2",
    "Gerado em 13/10/2026 às 10:05 pelo CrediAI · Documento sem assinaturas",
  ]) assert.ok(text.replace(/\n/g, " ").includes(expected), `faltou "${expected}"`);
  // A data da assinatura fica em branco: a data de geração não é apresentada como data de assinatura.
  assert.ok(!/São Paulo\/SP, 13/.test(text));
});

test("CT2. acentuação, moeda em reais e paginação", async () => {
  const notes = Array.from({ length: 60 }, (_, index) => `Condição ${index + 1}: pagamento em espécie ou PIX, ação, órgão, ênfase, à vista, coração, pôr, ü 😀`).join("\n");
  const bytes = await render(source({ investment: { notes, amountCents: 123_456_789 } }), true);
  const pages = pdfPages(bytes);
  assert.ok(pages.length >= 3, "o texto longo quebra em páginas");
  pages.forEach((page, index) => assert.ok(page.includes(`Página ${index + 1} de ${pages.length}`), `rodapé da página ${index + 1}`));
  const text = pdfText(bytes);
  for (const word of ["Condição 60", "ação", "órgão", "ênfase", "à vista", "coração", "pôr", "ü", "CLÁUSULA", "QUALIFICAÇÃO", "Ribeirão", "–"]) assert.ok(text.includes(word), word);
  assert.ok(text.replace(/\s+/g, " ").includes("R$ 1.234.567,89 (um milhão, duzentos e trinta e quatro mil, quinhentos e sessenta e sete reais e oitenta e nove centavos)"));
  assert.ok(text.includes("?"), "emoji, que a fonte não tem, vira ? em vez de quebrar o PDF");
  assert.ok(!text.includes("�"));
  // As assinaturas das partes ficam juntas, na mesma página.
  const signaturePage = pages.find((page) => page.includes("TESTEMUNHAS"));
  assert.ok(signaturePage.includes("CONTRATANTE\nGestão de Crédito Ação Ltda.") && signaturePage.includes("INVESTIDOR\nJoão Conceição Araújo"));
});

test("CT3. valores por extenso", () => {
  assert.equal(moneyInWords(100), "um real");
  assert.equal(moneyInWords(1), "um centavo");
  assert.equal(moneyInWords(150_050), "mil e quinhentos reais e cinquenta centavos");
  assert.equal(moneyInWords(10_000_000), "cem mil reais");
  assert.equal(moneyInWords(100_000_000), "um milhão de reais");
  assert.equal(moneyInWords(250_000_000), "dois milhões e quinhentos mil reais");
  assert.equal(moneyInWords(100_000_000_000), "um bilhão de reais");
  assert.equal(integerInWords(1_230), "mil, duzentos e trinta");
  assert.equal(integerInWords(1_200), "mil e duzentos");
  assert.equal(integerInWords(101), "cento e um");
  assert.equal(integerInWords(2_000_015), "dois milhões e quinze");
  assert.equal(integerInWords(19), "dezenove");
});

test("CT4. sem dados essenciais o contrato final não é gerado e a lista diz o que falta", () => {
  assert.deepEqual(missingContractData(source(), false), []);
  const data = source();
  data.contractor = null;
  const noContractor = missingContractData(data, false).filter((item) => item.section === "Empresa contratante");
  assert.ok(noContractor.length >= 3 && noContractor.some((item) => item.item === "confirmação dos dados"));
  const unconfirmed = missingContractData(source({ contractor: { confirmedAt: null } }), false);
  assert.deepEqual(unconfirmed, [{ section: "Empresa contratante", item: "confirmação dos dados" }]);
  const incomplete = missingContractData(source({ investor: { document: null, address: address({ Number: null }) }, investment: { maturityDate: null, dueDay: null } }), false).map((item) => `${item.section}: ${item.item}`);
  assert.ok(incomplete.includes("Investidor: CPF ou CNPJ"));
  assert.ok(incomplete.some((item) => item.startsWith("Investidor: endereço completo")));
  assert.ok(incomplete.includes("Investimento: vencimento do contrato ou dia de vencimento"));
  assert.ok(missingContractData(source({ investment: { status: "CANCELED" } }), false).length === 1);
  // Período "outro": só com as observações (onde o período é descrito) incluídas no contrato.
  assert.equal(missingContractData(source({ investment: { ratePeriod: "OTHER", notes: null } }), true).length, 1);
  assert.equal(missingContractData(source({ investment: { ratePeriod: "OTHER", notes: "Taxa no trimestre" } }), false).length, 1);
  assert.deepEqual(missingContractData(source({ investment: { ratePeriod: "OTHER", notes: "Taxa no trimestre" } }), true), []);
  assert.equal(contractRateText(200, "OTHER"), "2%, no período descrito nas condições adicionais deste instrumento");
});

test("CT5. o contrato não inventa regras nem reaproveita o modelo de empréstimo", async () => {
  const text = pdfText(await render(source())).toLowerCase();
  for (const forbidden of ["empréstimo", "mutu", "juros de mora", "multa de", "foro", "amortiza", "capitaliza mensal", "correção monetária", "assinado digitalmente", "assinado eletronicamente"]) {
    assert.ok(!text.includes(forbidden), `não pode conter "${forbidden}"`);
  }
  // A única taxa no texto é a cadastrada; nenhum valor de rendimento é calculado.
  assert.deepEqual(text.match(/\d+(,\d+)?%/g), ["1,5%"]);
  assert.ok(!/r\$ (?!50\.000,50|500,00)/.test(text), "nenhum outro valor em reais aparece (só o investido e o rendimento digitado)");
  // Observações só entram quando o usuário escolhe.
  const withNotes = pdfText(await render(source({ investment: { notes: "Rendimentos pagos por PIX até o dia 10." } }), true));
  const withoutNotes = pdfText(await render(source({ investment: { notes: "Rendimentos pagos por PIX até o dia 10." } }), false));
  assert.ok(withNotes.includes("CONDIÇÕES ADICIONAIS") && withNotes.includes("Rendimentos pagos por PIX até o dia 10."));
  assert.ok(!withoutNotes.includes("PIX"));
});

test("CT6. dados da empresa contratante: rascunho permitido, confirmação só com tudo preenchido", () => {
  const complete = { legalName: "Empresa Ltda", document: "11.222.333/0001-81", addressCep: "01310-100", addressStreet: "Av. Paulista", addressNumber: "1000", addressDistrict: "Bela Vista", addressCity: "São Paulo", addressState: "SP" };
  const draft = contractorFields(form({ legalName: "Empresa Ltda" }));
  assert.equal(draft.ok, true);
  assert.equal(draft.values.confirmed, false);
  const refused = contractorFields(form({ legalName: "Empresa Ltda", confirmed: "1" }));
  assert.equal(refused.ok, false);
  assert.match(refused.error, /CNPJ ou CPF/);
  const confirmed = contractorFields(form({ ...complete, confirmed: "1", representativeName: "Ana", representativeDocument: "411.797.058-58" }));
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.values.document, "11222333000181");
  assert.equal(confirmed.values.address.Cep, "01310100");
  assert.equal(confirmed.values.representativeDocument, "41179705858");
  assert.equal(contractorFields(form({ ...complete, addressState: "XX" })).ok, false);
  assert.equal(contractorFields(form({ ...complete, addressCep: "123" })).ok, false);
  assert.equal(contractorFields(form({ ...complete, representativeDocument: "411.797.058-58" })).ok, false, "CPF do representante sem nome");
  // Endereço do investidor: opcional no cadastro, normalizado quando informado.
  const person = { personType: "PF", name: "Ana", document: "411.797.058-58" };
  const investor = investorFields(form({ ...person, addressCep: "01310-100", addressCity: "São Paulo", addressState: "SP" }), "2026-10-15");
  assert.equal(investor.values.addressCep, "01310100");
  assert.equal(investorFields(form({ ...person, addressState: "ZZ" }), "2026-10-15").ok, false);
  assert.equal(addressLine(addressFields(form({ aCep: "01310100", aStreet: "Rua A", aNumber: "s/n", aCity: "Campinas", aState: "SP" }), "a").value), "Rua A, s/n, Campinas/SP, CEP 01310-100");
});

test("CT7. versões: o hash dos dados muda só quando o texto do contrato muda", () => {
  const base = contractFingerprint(source(), false);
  assert.equal(contractFingerprint(source(), false), base, "gerar de novo com os mesmos dados dá o mesmo hash");
  assert.notEqual(contractFingerprint(source({ investment: { amountCents: 5_000_051 } }), false), base);
  assert.notEqual(contractFingerprint(source({ investor: { name: "Outro Nome" } }), false), base);
  assert.notEqual(contractFingerprint(source({ contractor: { legalName: "Outra Ltda" } }), false), base);
  assert.notEqual(contractFingerprint(source(), true), base);
  // Observações fora do contrato: alterá-las não pede nova versão.
  assert.equal(contractFingerprint(source({ investment: { notes: "nova obs" } }), false), base);
  // A confirmação dos dados e o status não mudam o texto.
  assert.equal(contractFingerprint(source({ contractor: { confirmedAt: "2030-01-01" }, investment: { status: "PENDING_SIGNATURE" } }), false), base);
  assert.match(base, new RegExp(CONTRACT_TEMPLATE_VERSION));
});

test("CT8. estados do contrato gerado e nome do arquivo", () => {
  assert.equal(contractState({ sentAt: null, supersededAt: null, signed: false }), "GENERATED");
  assert.equal(contractState({ sentAt: "x", supersededAt: null, signed: false }), "SENT");
  assert.equal(contractState({ sentAt: null, supersededAt: "x", signed: false }), "SUPERSEDED");
  assert.equal(contractState({ sentAt: "x", supersededAt: "x", signed: true }), "SIGNED", "assinado só com documento anexado");
  assert.equal(contractFileName("João Conceição Araújo", 3), "contrato-investimento-joao-conceicao-araujo-v3.pdf");
  assert.equal(contractFileName("../../etc", 1), "contrato-investimento-etc-v1.pdf");
});

test("CT9. migration 0016 só cria estrutura: nenhuma linha existente é alterada ou apagada", () => {
  const sql = readFileSync("drizzle/0016_investment_contracts.sql", "utf8").replace(/^--.*$/gm, "");
  assert.ok(!/(^|breakpoint)\s*(UPDATE|DELETE|TRUNCATE|DROP|INSERT)\b/im.test(sql));
  assert.ok(!/\bDROP\b/i.test(sql));
  assert.ok(!/ALTER TABLE "(loan_operation|payment|subscription|wallet|tenant|user|client|investment)"/.test(sql));
  for (const table of ["investment_contract", "investment_contractor"]) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
  }
  // Colunas novas só opcionais (sem NOT NULL nem DEFAULT que reescreva linhas).
  for (const match of sql.matchAll(/ALTER TABLE "(investor|investment_document)" ADD COLUMN "[a-z_]+" text;/g)) assert.ok(match);
  assert.ok(!/ADD COLUMN[^;]*NOT NULL/.test(sql));
  // Versão gerada sempre do mesmo investimento e tenant; contrato assinado aponta para a versão do mesmo tenant.
  assert.match(sql, /"investment_contract_investment_same_tenant_fk" FOREIGN KEY \("tenant_id","investment_id"\) REFERENCES "public"."investment"\("tenant_id","id"\)/);
  assert.match(sql, /"investment_document_contract_same_tenant_fk" FOREIGN KEY \("tenant_id","contract_id"\) REFERENCES "public"."investment_contract"\("tenant_id","id"\)/);
  assert.match(sql, /CREATE UNIQUE INDEX "investment_contract_current_unique"/);
  assert.match(sql, /'investment_contract', 'investment_contractor'/);
});

test("CT10. cláusulas de liquidez/resgate e de remuneração; liquidez obrigatória", async () => {
  const text = (data) => pdfText(Buffer.from(data)).replace(/\s+/g, " ");
  const atEnd = text(await render(source(), false));
  for (const expected of [
    "DA LIQUIDEZ E DO RESGATE", "A liquidez do crédito investido é: ao término do contrato, em 13/10/2027.",
    "somente poderá resgatar o crédito investido na data de liquidez", "não havendo direito a resgate antecipado",
    "poderá, a seu exclusivo critério, devolver o crédito investido, total ou parcialmente, a qualquer momento antes da data de liquidez",
    "A remuneração será paga com periodicidade mensal, no valor de R$ 500,00 (quinhentos reais) a cada pagamento, no dia 10 de cada mês",
  ]) assert.ok(atEnd.includes(expected), `faltou "${expected}"`);
  const dPlus = text(await render(source({ investment: { redemptionRule: "D_PLUS", redemptionDays: 30 } }), false));
  assert.ok(dPlus.includes("D+30, isto é, 30 dias corridos após o término do contrato, em 12/11/2027."));
  const bare = text(await render(source({ investment: { paymentFrequency: null, yieldPaymentCents: null } }), false));
  assert.ok(bare.includes("não estabelece forma de cálculo, capitalização, periodicidade ou data de pagamento"), "sem remuneração informada, o texto não presume nada");
  assert.ok(!bare.includes("A remuneração será paga"));
  assert.deepEqual(missingContractData(source({ investment: { redemptionRule: null, redemptionDays: null } }), false), [{ section: "Investimento", item: "liquidez (ao término do contrato ou D+ dias)" }]);
  assert.notEqual(contractFingerprint(source({ investment: { redemptionRule: "D_PLUS", redemptionDays: 30 } }), false), contractFingerprint(source(), false));
  assert.notEqual(contractFingerprint(source({ investment: { yieldPaymentCents: 60_000 } }), false), contractFingerprint(source(), false));
});

test("CT6. datas do primeiro e do último pagamento no contrato; vencimento termina no último pagamento", async () => {
  const text = pdfText(await render(source({ investment: { startDate: "2026-07-15", maturityDate: "2027-06-25", firstPaymentDate: "2026-08-25", lastPaymentDate: "2027-07-25" } })));
  assert.match(text, /Data do primeiro pagamento: 25\/08\/2026/);
  assert.match(text, /Data do último pagamento: 25\/07\/2027/);
  assert.match(text, /Vencimento do contrato: 25\/07\/2027/);
  assert.doesNotMatch(text, /25\/06\/2027/);
});
