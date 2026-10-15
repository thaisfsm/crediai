// Regra da entrada no capital para a baixa de investidores (migração 0023): contrato novo só recebe baixa com a entrada
// registrada; contrato antigo (cadastrado antes da regra) com a entrada ou com o aporte anterior indicado pelo usuário;
// sem nenhum dos dois, a baixa fica bloqueada com explicação (nada é classificado em silêncio).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ENTRY_REQUIRED_ERROR, LEGACY_EVIDENCE_ERROR, buildObligations, checkCapitalEntry, checkPriorContribution, entryEvidence, filterObligations, isLegacyContract,
} from "../src/lib/investors/payables.ts";

const TODAY = "2026-10-14";
const contract = (extra = {}) => ({ capitalEntryRule: "REQUIRED", hasEntry: false, hasPriorContribution: false, status: "ACTIVE", ...extra });
const aporte = (extra = {}) => ({ id: "cap-1", kind: "CONTRIBUTION", source: "CAPITAL", occurredAt: "2026-09-01", amountCents: 1_000_000, reversed: false, ...extra });

test("RE1. contrato novo: sem entrada a baixa é bloqueada; com a entrada, liberada", () => {
  assert.deepEqual(entryEvidence(contract()), { ok: false, error: ENTRY_REQUIRED_ERROR });
  assert.deepEqual(entryEvidence(contract({ hasEntry: true })), { ok: true });
  // Um aporte anterior não serve para contrato novo (nem se alguém forjar a marca).
  assert.equal(entryEvidence(contract({ hasPriorContribution: true })).ok, false);
  assert.equal(isLegacyContract(contract()), false);
});

test("RE2. contrato antigo: com a entrada ou com o aporte anterior indicado, liberada; sem evidência, bloqueada com explicação", () => {
  assert.deepEqual(entryEvidence(contract({ capitalEntryRule: null, hasEntry: true })), { ok: true });
  assert.deepEqual(entryEvidence(contract({ capitalEntryRule: null, hasPriorContribution: true })), { ok: true });
  assert.deepEqual(entryEvidence(contract({ capitalEntryRule: null })), { ok: false, error: LEGACY_EVIDENCE_ERROR });
  assert.match(LEGACY_EVIDENCE_ERROR, /registre a entrada.*ou indique.*aporte/);
  // A marca de contrato antigo vem SÓ do valor gravado no banco (NULL); a idade do cadastro não entra na regra.
  assert.equal(isLegacyContract({ capitalEntryRule: null }), true);
  assert.equal(isLegacyContract({ capitalEntryRule: undefined }), false, "ausência de informação não vira contrato antigo");
});

test("RE3. obrigações mostram por que a baixa está bloqueada, por contrato", () => {
  const base = { investorId: "i", investorName: "Ana", contractNumber: null, status: "ACTIVE", startDate: "2026-01-10", amountCents: 1_000_000 };
  const list = buildObligations({
    investments: [
      { ...base, id: "novo", capitalEntryRule: "REQUIRED", hasEntry: false, hasPriorContribution: false },
      { ...base, id: "novo-ok", capitalEntryRule: "REQUIRED", hasEntry: true, hasPriorContribution: false },
      { ...base, id: "antigo", capitalEntryRule: null, hasEntry: false, hasPriorContribution: false },
      { ...base, id: "antigo-ok", capitalEntryRule: null, hasEntry: false, hasPriorContribution: true },
    ],
    items: ["novo", "novo-ok", "antigo", "antigo-ok"].map((investmentId, index) => ({ id: `it-${investmentId}`, investmentId, number: 1, dueDate: `2026-10-1${index}`, yieldCents: 100, principalCents: 0, description: null })),
    payments: [], today: TODAY,
  });
  assert.deepEqual(Object.fromEntries(list.map((obligation) => [obligation.investmentId, obligation.paymentBlock])), {
    novo: ENTRY_REQUIRED_ERROR, "novo-ok": null, antigo: LEGACY_EVIDENCE_ERROR, "antigo-ok": null,
  });
  // A busca ignora acentos e espaços repetidos (mesma normalização da busca de clientes).
  assert.equal(filterObligations(list, { q: "  ANA ", from: null, to: null, status: null, kind: null }).length, 4);
});

test("RE4. aporte anterior: só contrato antigo, sem entrada, uma vez, aporte comum do ciclo, não estornado, não futuro", () => {
  const legacy = contract({ capitalEntryRule: null });
  const ok = (extra = {}) => checkPriorContribution({ investment: legacy, alreadyDeclared: false, movement: aporte(), cycleStartedOn: "2026-08-01", today: TODAY, ...extra });
  assert.deepEqual(ok(), { ok: true });
  assert.match(ok({ investment: contract() }).error, /cadastrado com a regra da entrada/);
  assert.match(ok({ investment: contract({ capitalEntryRule: null, hasEntry: true }) }).error, /já está registrada/);
  assert.match(ok({ investment: contract({ capitalEntryRule: null, status: "CANCELED" }) }).error, /cancelado/);
  assert.match(ok({ alreadyDeclared: true }).error, /já foi indicado/);
  assert.match(ok({ movement: null }).error, /não encontrado/);
  assert.match(ok({ movement: aporte({ source: "INVESTOR" }) }).error, /não pode ser usado/);
  assert.match(ok({ movement: aporte({ kind: "WITHDRAWAL" }) }).error, /não pode ser usado/);
  assert.match(ok({ movement: aporte({ reversed: true }) }).error, /não pode ser usado/);
  assert.match(ok({ movement: aporte({ occurredAt: "2026-10-20" }) }).error, /data futura/);
  assert.match(ok({ movement: aporte({ occurredAt: "2026-07-31" }) }).error, /anterior ao início do ciclo/);
});

test("RE5. entrada e aporte anterior se excluem (o dinheiro não é contado em dobro)", () => {
  const base = { enteredOn: "2026-09-01", today: TODAY, cycleStartedOn: null, investmentStatus: "ACTIVE", hasWallet: true, alreadyRegistered: false };
  assert.deepEqual(checkCapitalEntry(base), { ok: true });
  assert.match(checkCapitalEntry({ ...base, priorContributionDeclared: true }).error, /em dobro/);
});

test("RE6. código e migração 0023: aditiva, sem backfill, travas no banco e no servidor", () => {
  const migration = readFileSync("drizzle/0023_regra_entrada.sql", "utf8");
  // Coluna nova SEM valor padrão (as linhas existentes ficam NULL) e nenhuma linha existente alterada ou apagada.
  assert.match(migration, /ALTER TABLE "investment" ADD COLUMN "capital_entry_rule" text;/);
  assert.ok(!/capital_entry_rule" text DEFAULT|SET DEFAULT/i.test(migration));
  assert.ok(!/\bDROP (TABLE|CONSTRAINT|COLUMN)\b|\bDELETE FROM\b|\bUPDATE\s+"?\w+"?\s+SET\b|\bTRUNCATE\s+"?\w/i.test(migration.replace(/BEFORE TRUNCATE/g, "")));
  for (const name of ["investment_entry_rule", "investment_cash_guard", "investment_prior_contribution_check", "investment_prior_contribution_append_only",
    "investment_prior_contribution_no_truncate", "capital_movement_prior_contribution_not_reversed"]) assert.ok(migration.includes(`CREATE TRIGGER "${name}"`), name);
  assert.match(migration, /NEW\.capital_entry_rule := 'REQUIRED'/, "contrato novo sempre nasce com a regra, mesmo se mandarem NULL");
  assert.match(migration, /registre antes a entrada deste investimento no capital/);
  const actions = readFileSync("src/app/contas-a-pagar/actions.ts", "utf8");
  assert.ok(actions.includes("entryEvidence(") && actions.includes("export async function declarePriorContributionAction"));
  assert.ok(actions.includes('action: "INVESTMENT_PRIOR_CONTRIBUTION_DECLARED"'));
  assert.equal((actions.match(/tx\.insert\(capitalMovements\)/g) ?? []).length, 2, "indicar aporte anterior não lança nada no capital");
  assert.ok(!/\.delete\(|\.update\(/.test(actions));
  const capital = readFileSync("src/app/actions.ts", "utf8");
  assert.match(capital, /indicado como a entrada do dinheiro de um contrato de investidor e não pode ser estornado/);
});
