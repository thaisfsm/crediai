import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchPortfolio } from "../src/lib/finance/search.ts";

// Busca global do topo (dados fictícios).
const clients = [
  { id: "c1", name: "Ana Júlia Prado", document: "123.456.789-00", phone: "(11) 98765-4321", email: "ana@exemplo.com" },
  { id: "c2", name: "Bruno Lima", document: null, phone: null, email: null },
];
const operations = [
  { id: "o1", code: "OP-AB12CD", clientId: "c1", clientName: "Ana Júlia Prado" },
  { id: "o2", code: "OP-99ZZ00", clientId: "c2", clientName: "Bruno Lima" },
];
const find = (q) => searchPortfolio(q, clients, operations);

test("ignora acento e maiúsculas no nome", () => {
  const results = find("julia");
  assert.deepEqual(results.map((r) => `${r.kind}:${r.id}`), ["client:c1", "operation:o1"]);
});

test("encontra por CPF e telefone só com dígitos", () => {
  assert.equal(find("12345678900")[0].id, "c1");
  assert.equal(find("98765")[0].id, "c1");
});

test("encontra operação pelo código, com ou sem #", () => {
  assert.deepEqual(find("#op-99zz").map((r) => r.id), ["o2"]);
  assert.deepEqual(find("ab12").map((r) => r.id), ["o1"]);
});

test("consulta curta ou sem correspondência não retorna nada", () => {
  assert.deepEqual(find("a"), []);
  assert.deepEqual(find("inexistente"), []);
});

test("respeita o limite de resultados", () => {
  assert.equal(searchPortfolio("op", clients, operations, 1).length, 1);
});

// Estruturais (mesmo estilo de database-status.test.mjs): garantias que não dependem de banco.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a busca é pura: não importa banco, sessão nem ação de servidor (não abre caminho para outro tenant)", () => {
  const source = read("src/lib/finance/search.ts");
  assert.doesNotMatch(source, /from "@\/lib\/(db|auth)|use server|fetch\(/);
});

test("o dashboard busca só nos dados da carteira da sessão (portfolio vindo de loadTenantPortfolio)", () => {
  const dashboard = read("src/app/dashboard.tsx");
  assert.match(dashboard, /searchPortfolio\(searchQuery, portfolio\.clients, portfolio\.operations\)/);
  assert.match(read("src/app/page.tsx"), /const portfolio = await loadTenantPortfolio\(\);/);
  // Entrada limitada no campo.
  assert.match(dashboard, /aria-label="Buscar clientes ou operações" maxLength=\{80\}/);
});

test("/setup redireciona no servidor em produção quando o banco está no ar e não mostra comandos do ambiente", () => {
  const setup = read("src/app/setup/page.tsx");
  assert.match(setup, /import \{ redirect \} from "next\/navigation";/);
  assert.match(setup, /if \(status === "ok"\) \{\n\s+if \(process\.env\.NODE_ENV === "production"\) redirect\("\/"\);/);
  assert.doesNotMatch(setup, /^"use client"/m);
});
