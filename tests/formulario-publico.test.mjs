import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLIENT_DATA_KEYS, CLIENT_DATA_STEPS, REQUIRED_CLIENT_DATA, filledSteps, isClientDataStep, missingForSubmit } from "../src/lib/credit/client-data-steps.ts";
import { clientProfileKeys } from "../src/lib/finance/client-profile.ts";

test("FP1. o formulário público cobre todos os campos do cadastro de Clientes (menos os internos do dono)", () => {
  // Todos os campos do cadastro completo (dados pessoais, contatos e redes, endereços, empresa, banco/Pix, referências, avalista).
  assert.deepEqual([...CLIENT_DATA_KEYS].sort(), [...clientProfileKeys].sort());
  assert.equal(new Set(CLIENT_DATA_KEYS).size, CLIENT_DATA_KEYS.length, "nenhum campo em duas etapas");
  // Colunas da tabela client: as que não estão no formulário público são só a identidade (na etapa Proposta) e as internas.
  const schema = readFileSync("src/lib/db/schema.ts", "utf8");
  const block = schema.slice(schema.indexOf('export const clients = pgTable("client"'), schema.indexOf("export const loanOperations"));
  const columns = [...block.matchAll(/^\s{2}(\w+): (?:text|date|boolean|integer|timestamp)\(/gm)].map((match) => match[1]);
  const identity = ["name", "document", "phone"];
  const internal = ["id", "tenantId", "notes", "onlineCasinoBettor", "accountManagerId", "accountManagerBps", "archivedAt", "createdAt", "updatedAt"];
  const uncovered = columns.filter((column) => !CLIENT_DATA_KEYS.includes(column) && !identity.includes(column) && !internal.includes(column));
  assert.deepEqual(uncovered, [], "campo novo de Clientes esquecido no formulário público");
  for (const key of ["birthDate", "whatsapp", "email", "instagram", "facebook", "tiktok", "residentialCep", "businessCnpj", "businessCompanyName", "businessAdmissionDate", "businessCity", "pixKey", "bankAccount", "reference2Phone", "guarantorDocument"]) assert.ok(CLIENT_DATA_KEYS.includes(key), key);
});

test("FP2. etapas, obrigatórios e progresso", () => {
  assert.deepEqual(CLIENT_DATA_STEPS.map((step) => step.key), ["personal", "home", "work", "bank", "references"]);
  assert.equal(isClientDataStep("home"), true);
  assert.equal(isClientDataStep("notes"), false);
  assert.deepEqual(filledSteps(null), []);
  assert.deepEqual(filledSteps({ birthDate: "1990-01-01", pixKey: "x" }), ["personal", "bank"]);
  const proposal = { applicantName: "Joana Teste", cpf: "52998224725", phone: "11987654321", monthlyIncomeCents: 350000 };
  assert.deepEqual(missingForSubmit({}, proposal), REQUIRED_CLIENT_DATA.map((field) => field.label));
  assert.deepEqual(missingForSubmit({}, { ...proposal, phone: null, monthlyIncomeCents: null }).slice(0, 2), ["Telefone", "Renda mensal"]);
  const complete = Object.fromEntries(REQUIRED_CLIENT_DATA.map((field) => [field.key, "x"]));
  assert.deepEqual(missingForSubmit(complete, proposal), []);
});
