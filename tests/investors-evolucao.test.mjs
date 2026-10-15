import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountFitsMethod, bankAccountFields, bankAccountLabel, maskAccountNumber, maskDocument, maskPixKey } from "../src/lib/investors/bank-accounts.ts";
import { investmentDivergences, investmentPosition, scheduleLines } from "../src/lib/investors/position.ts";
import { buildObligations, checkCapitalEntry, entryEvidence, RENEWAL_ORIGIN_ERROR } from "../src/lib/investors/payables.ts";
import { personTypeOf } from "../src/lib/investors/rules.ts";

const form = (values) => (key, max) => String(values[key] ?? "").trim().slice(0, max);

test("EV1. conta bancária: só se exige o que se aplica (banco completo, só Pix, ou os dois)", () => {
  const bank = bankAccountFields(form({ bankCode: "341", bankName: "Itaú", branch: "1234", branchDigit: "5", account: "123456", accountDigit: "X", accountType: "CHECKING", holderName: "Ana", holderDocument: "411.797.058-58" }));
  assert.equal(bank.ok, true);
  assert.equal(bank.values.accountDigit, "X");
  assert.equal(bank.values.holderDocument, "41179705858");
  assert.equal(bank.values.pixKey, null);
  const pixOnly = bankAccountFields(form({ pixKeyType: "EMAIL", pixKey: "Ana@Exemplo.com", isPreferred: "1" }));
  assert.equal(pixOnly.ok, true, "só Pix não exige agência nem conta");
  assert.equal(pixOnly.values.pixKey, "ana@exemplo.com");
  assert.equal(pixOnly.values.isPreferred, true);
  assert.equal(bankAccountFields(form({})).ok, false, "nem conta nem Pix");
  assert.equal(bankAccountFields(form({ bankName: "Itaú", branch: "1234" })).ok, false, "banco sem conta");
  assert.equal(bankAccountFields(form({ bankCode: "34", branch: "1", account: "1" })).ok, false, "código do banco com 3 números");
  assert.equal(bankAccountFields(form({ bankCode: "341", branch: "12a", account: "1" })).ok, false);
  assert.equal(bankAccountFields(form({ bankCode: "341", branch: "1", account: "1", accountType: "XYZ" })).ok, false);
  assert.equal(bankAccountFields(form({ pixKeyType: "CPF", pixKey: "111.111.111-11" })).ok, false);
  assert.equal(bankAccountFields(form({ pixKey: "ana@exemplo.com" })).ok, false, "chave Pix sem tipo");
  assert.equal(bankAccountFields(form({ pixKeyType: "EMAIL", pixKey: "a@b.com", holderDocument: "411.797.058-59" })).ok, false);
});

test("EV2. dados bancários aparecem mascarados; forma de pagamento precisa servir na conta", () => {
  assert.equal(maskAccountNumber("123456", "7"), "•••456-7");
  assert.equal(maskDocument("41179705858"), "•••5858");
  assert.equal(maskPixKey("EMAIL", "ana.silva@exemplo.com"), "an•••@exemplo.com");
  assert.equal(maskPixKey("CPF", "41179705858"), "•••.797.•••-58");
  assert.equal(maskPixKey("PHONE", "11987654321"), "(11) •••••-4321");
  const label = bankAccountLabel({ bankCode: "341", bankName: "Itaú", branch: "1234", branchDigit: null, account: "123456", accountDigit: "7", pixKeyType: "EMAIL", pixKey: "ana.silva@exemplo.com" });
  assert.equal(label, "341 Itaú · ag. 1234 · conta •••456-7 · Pix E-mail an•••@exemplo.com");
  assert.ok(!label.includes("123456") && !label.includes("ana.silva"));
  assert.match(accountFitsMethod("PIX", { pixKey: null, account: "1", branch: "1" }), /Pix/);
  assert.match(accountFitsMethod("TRANSFER", { pixKey: "x", account: null, branch: null }), /transferência/);
  assert.equal(accountFitsMethod("CASH", { pixKey: null, account: null, branch: null }), null);
  assert.equal(accountFitsMethod("PIX", null), null);
});

test("EV3. tipo de pessoa: o guardado vale; contrato antigo sem tipo é mostrado pelo documento, sem gravar", () => {
  assert.equal(personTypeOf({ personType: "PJ", document: "41179705858" }), "PJ");
  assert.equal(personTypeOf({ personType: null, document: "41179705858" }), "PF");
  assert.equal(personTypeOf({ personType: null, document: "11222333000181" }), "PJ");
  assert.equal(personTypeOf({ personType: null, document: null }), null);
});

const item = (number, dueDate, yieldCents, principalCents) => ({ id: `i${number}`, number, dueDate, yieldCents, principalCents, description: null });
const pay = (id, scheduleItemId, kind, amountCents, paidOn) => ({ id, scheduleItemId, kind, amountCents, paidOn, method: "PIX", reference: null, capitalMovementId: `m${id}`, createdAt: `${paidOn}T12:00:00Z` });
// Contrato de R$ 100.000 por 12 meses: rendimentos mensais de R$ 5.000 e principal em duas metades (6º e 12º mês).
const contract = { amountCents: 10_000_000, status: "ACTIVE", startDate: "2026-01-15", maturityDate: "2027-01-15" };
const items = [
  ...Array.from({ length: 12 }, (_, index) => item(index + 1, `${index < 11 ? 2026 : 2027}-${String(((index + 1) % 12) + 1).padStart(2, "0")}-15`, 500_000, 0)),
  item(13, "2026-07-15", 0, 5_000_000), item(14, "2027-01-15", 0, 5_000_000),
];

test("EV4. painel do contrato: tudo somado dos registros; nada vira pago porque a data passou; sem multa nem juros", () => {
  const payments = [pay("p1", "i1", "YIELD", 500_000, "2026-02-15"), pay("p2", "i2", "YIELD", 200_000, "2026-03-20"), pay("p3", "i13", "PRINCIPAL", 5_000_000, "2026-07-15")];
  const lines = scheduleLines(items, payments, "ACTIVE", "2026-08-01");
  assert.equal(lines[0].status, "PAGA");
  assert.equal(lines[1].status, "VENCIDA", "pagamento parcial com data passada continua vencida");
  assert.equal(lines[2].status, "VENCIDA", "data passou sem baixa: vencida, nunca paga");
  assert.equal(lines[12].status, "PAGA");
  assert.equal(lines[12].kind, "PRINCIPAL");
  const position = investmentPosition({ investment: contract, lines, entryCents: 10_000_000, priorContribution: false, today: "2026-08-01" });
  assert.deepEqual(position, {
    principalContractedCents: 10_000_000,
    principalReceived: { kind: "entry", cents: 10_000_000 },
    principalReturnedCents: 5_000_000,
    principalRolledOverCents: 0,
    principalRemainingCents: 5_000_000,
    principalScheduledCents: 10_000_000,
    principalUnscheduledCents: 0,
    yieldExpectedCents: 6_000_000,
    yieldPaidCents: 700_000,
    yieldPendingCents: 5_300_000,
    obligationsTotalCents: 16_000_000,
    paidTotalCents: 5_700_000,
    nextDueDate: "2026-03-15",
    pendingCount: 12,
    overdueCount: 5,
  });
  // Principal sem data de devolução aparece como não agendado (o cronograma não precisa somar o principal).
  const partial = investmentPosition({ investment: contract, lines: scheduleLines(items.slice(0, 13), [], "ACTIVE", "2026-01-20"), entryCents: null, priorContribution: false, today: "2026-01-20" });
  assert.equal(partial.principalUnscheduledCents, 5_000_000);
  assert.equal(partial.principalReceived, null);
  assert.equal(partial.overdueCount, 0);
  // Cancelado: linhas sem pagamento não contam como pendentes.
  const canceled = investmentPosition({ investment: { ...contract, status: "CANCELED" }, lines: scheduleLines(items, [], "CANCELED", "2026-08-01"), entryCents: null, priorContribution: false, today: "2026-08-01" });
  assert.equal(canceled.pendingCount, 0);
  assert.equal(canceled.yieldPendingCents, 0);
});

test("EV5. divergências de dados antigos são apontadas, nunca corrigidas", () => {
  const lines = scheduleLines([item(1, "2025-12-01", 100, 0), item(2, "2027-06-01", 0, 11_000_000)], [], "CLOSED", "2026-08-01");
  const problems = investmentDivergences({ investment: { ...contract, status: "CLOSED" }, lines, entryCents: 9_000_000 });
  assert.equal(problems.length, 5);
  assert.match(problems[0], /mais que o valor do contrato/);
  assert.match(problems[1], /entrada registrada no capital/);
  assert.match(problems[2], /anterior ao início/);
  assert.match(problems[3], /depois do vencimento/);
  assert.match(problems[4], /encerrado/);
  assert.deepEqual(investmentDivergences({ investment: contract, lines: scheduleLines(items, [], "ACTIVE", "2026-01-20"), entryCents: 10_000_000 }), []);
});

test("EV6. renovação: o principal restante passa para o novo contrato, sem nova entrada; o anterior não cobra mais principal", () => {
  const payments = [pay("p3", "i13", "PRINCIPAL", 5_000_000, "2026-07-15")];
  const lines = scheduleLines(items, payments, "CLOSED", "2027-02-01", { renewed: true });
  assert.equal(lines[13].status, "RENOVADA");
  assert.equal(lines[13].balanceCents, 0);
  assert.equal(lines[13].rolledOverCents, 5_000_000);
  assert.equal(lines[0].status, "VENCIDA", "rendimento pendente do contrato renovado continua devido");
  const position = investmentPosition({ investment: { ...contract, status: "CLOSED" }, lines, entryCents: 10_000_000, priorContribution: false, today: "2027-02-01", renewed: true });
  assert.equal(position.principalRemainingCents, 0);
  assert.equal(position.principalRolledOverCents, 5_000_000);
  assert.equal(position.principalUnscheduledCents, 0);
  assert.equal(position.obligationsTotalCents, 6_000_000 + 5_000_000);
  const child = investmentPosition({ investment: { amountCents: 5_000_000, status: "ACTIVE", startDate: "2027-01-15", maturityDate: null }, lines: [], entryCents: null, priorContribution: false, today: "2027-02-01", renewedFrom: true });
  assert.deepEqual(child.principalReceived, { kind: "renewal", cents: 5_000_000 });
  assert.equal(child.principalRemainingCents, 5_000_000);
  // Contas a Pagar: no anterior só sobra rendimento; o novo depende do capital da origem e nunca recebe nova entrada.
  const base = { investorId: "v", investorName: "Ana", contractNumber: null, startDate: "2026-01-15", amountCents: 10_000_000, capitalEntryRule: "REQUIRED", hasEntry: true, hasPriorContribution: false };
  const obligations = buildObligations({ investments: [{ ...base, id: "old", status: "CLOSED", renewed: true }], items: items.map((row) => ({ ...row, investmentId: "old" })), payments, today: "2027-02-01" });
  assert.ok(!obligations.some((obligation) => obligation.kind === "PRINCIPAL" && obligation.balanceCents > 0));
  assert.equal(obligations.filter((obligation) => obligation.kind === "PRINCIPAL").length, 1, "só a metade já devolvida continua listada (paga)");
  assert.deepEqual(entryEvidence({ ...base, hasEntry: false, renewedFrom: "old", originHasCapital: true }), { ok: true });
  assert.deepEqual(entryEvidence({ ...base, hasEntry: false, renewedFrom: "old", originHasCapital: false }), { ok: false, error: RENEWAL_ORIGIN_ERROR });
  assert.match(checkCapitalEntry({ enteredOn: "2027-01-15", today: "2027-02-01", cycleStartedOn: null, investmentStatus: "ACTIVE", hasWallet: true, alreadyRegistered: false, isRenewal: true }).error, /renovação/);
});

test("EV7. migration 0024 só acrescenta: nenhuma linha existente é alterada ou apagada", () => {
  const sql = readFileSync("drizzle/0024_investidores_evolucao.sql", "utf8").replace(/^--.*$/gm, "");
  const statements = sql.split("--> statement-breakpoint").map((statement) => statement.trim());
  assert.ok(!statements.some((statement) => /^(UPDATE|DELETE|TRUNCATE|INSERT)\b/i.test(statement)));
  assert.ok(!/\bDROP\s+(TABLE|COLUMN)\b/i.test(sql));
  assert.ok(!/ALTER TABLE "\w+" ALTER COLUMN/i.test(sql), "nenhuma coluna existente muda");
  for (const table of ["investor_bank_account", "investor_document"]) {
    assert.match(sql, new RegExp(`CREATE TABLE "${table}"`));
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /CREATE TRIGGER "investment_renewal_check" BEFORE INSERT OR UPDATE ON "investment"/);
  assert.match(sql, /crediai_investment_has_capital/);
  // Dados bancários ficam fora da auditoria: no máximo "tem conta/tem Pix" e os nomes dos campos alterados.
  const actions = readFileSync("src/app/investidores/actions.ts", "utf8");
  const audits = [...actions.matchAll(/await audit\(tx, scope,[^;]*;/gs)].map((match) => match[0].replace(/Boolean\([^)]*\)/g, ""));
  assert.ok(audits.length > 10);
  for (const call of audits) assert.ok(!/\.(pixKey|account|accountDigit|branch|holderDocument|bankCode)\b/.test(call), `auditoria com dado bancário: ${call.slice(0, 120)}`);
});
