// Classificação da falha do banco (função pura, testada em tests/database-status.test.mjs):
//  • "unavailable": falha de conexão temporária (rede, tempo esgotado, banco reiniciando ou acordando, limite de
//    conexões). O app mostra "tente novamente" e NÃO manda para /setup, não encerra a sessão e não altera dados.
//  • "error": o banco respondeu com outro erro (por exemplo, credencial recusada ou esquema sem migration). Também
//    não vai para /setup: é um erro do ambiente/aplicação, mostrado com a mesma tela de nova tentativa.
// "not_configured" (DATABASE_URL ausente) é decidido antes, sem tentar conectar: só ele leva para /setup.
export type DatabaseStatus = "ok" | "not_configured" | "unavailable" | "error";

const TEMPORARY_CODES = new Set([
  // Rede e DNS (Node).
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  // Driver postgres.js.
  "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED",
  // PostgreSQL: desligamento/reinício, "cannot connect now" e falta de recursos (inclui limite de conexões).
  "57P01", "57P02", "57P03", "53000", "53100", "53200", "53300", "53400",
]);

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function classifyDatabaseError(error: unknown): Exclude<DatabaseStatus, "ok" | "not_configured"> {
  // Olha o erro e a causa encadeada (o Drizzle embrulha o erro do driver).
  for (let current: unknown = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const code = codeOf(current);
    // Classe 08 do SQLSTATE: exceções de conexão.
    if (code && (TEMPORARY_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code))) return "unavailable";
  }
  return "error";
}

// Nome e código da falha para o log, sem mensagem (que pode conter host ou usuário do banco).
export function databaseFailureTag(error: unknown) {
  const name = error instanceof Error ? error.name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) : "UnknownError";
  const code = (codeOf(error) ?? codeOf((error as { cause?: unknown } | null)?.cause) ?? "UNKNOWN").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  return { name, code };
}
