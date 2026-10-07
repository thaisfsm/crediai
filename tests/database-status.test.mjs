import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { classifyDatabaseError, databaseFailureTag } from "../src/lib/db/status-rules.ts";

const err = (code, extra = {}) => Object.assign(new Error("falha"), { code }, extra);

test("DB1. falha temporária de conexão vira 'unavailable' (não é banco não configurado)", () => {
  for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "57P01", "57P03", "53300", "08006", "08001"]) {
    assert.equal(classifyDatabaseError(err(code)), "unavailable", code);
  }
  // Erro do driver embrulhado pelo Drizzle (cause).
  assert.equal(classifyDatabaseError(Object.assign(new Error("Failed query"), { cause: err("CONNECT_TIMEOUT") })), "unavailable");
});

test("DB2. outros erros do banco ou da aplicação viram 'error'", () => {
  for (const code of ["28P01", "3D000", "42P01", "XX000", undefined]) assert.equal(classifyDatabaseError(err(code)), "error", String(code));
  assert.equal(classifyDatabaseError("texto"), "error");
  assert.equal(classifyDatabaseError(null), "error");
});

test("DB3. o log da falha não leva a mensagem (que pode conter host ou usuário do banco)", () => {
  const tag = databaseFailureTag(Object.assign(new Error("password authentication failed for user neondb_owner at ep-x.neon.tech"), { code: "28P01" }));
  assert.deepEqual(tag, { name: "Error", code: "28P01" });
});

function files(dir) {
  return readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : [path]; });
}

test("DB4. só banco NÃO configurado leva para /setup; nenhuma página redireciona para /setup por falha temporária", () => {
  for (const file of files("src/app").filter((path) => /page\.tsx$/.test(path))) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /databaseAvailable\(\)\)\) redirect\("\/setup"\)/, file);
    if (source.includes('redirect("/setup")')) {
      assert.match(source, /if \(gate === "not_configured"\) redirect\("\/setup"\);/, file);
      assert.match(source, /if \(gate !== "ok"\) return <DatabaseErrorState kind=\{gate\} \/>;/, file);
    }
  }
  const index = readFileSync("src/lib/db/index.ts", "utf8");
  // Nova tentativa automática de falha temporária e tempo de conexão que cobre a compute do Neon acordando.
  assert.match(index, /connect_timeout: 10/);
  assert.match(index, /attempt < 2/);
});

test("DB5. a tela de erro não encerra a sessão nem altera dados", () => {
  for (const file of ["src/app/database-error-state.tsx", "src/app/error.tsx", "src/app/retry-button.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /signOut|delete\(|update\(|insert\(|redirect\(/, file);
  }
});
