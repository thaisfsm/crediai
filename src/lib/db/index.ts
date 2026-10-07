import "server-only";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { connection } from "next/server";
import * as schema from "./schema";
import { classifyDatabaseError, databaseFailureTag, type DatabaseStatus } from "./status-rules";

export type { DatabaseStatus } from "./status-rules";

function createDatabase(databaseUrl: string) {
  // connect_timeout de 10 s: a compute do Neon suspensa por inatividade leva alguns segundos para acordar; com 3 s a
  // primeira requisição depois de uma pausa podia falhar e cair na tela de configuração.
  const client = postgres(databaseUrl, { max: 10, prepare: false, connect_timeout: 10 });
  return drizzle(client, { schema });
}

type Database = ReturnType<typeof createDatabase>;
let database: Database | undefined;
let lastLoggedDatabaseFailure: string | undefined;

function getDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL não está configurado.");
  database ??= createDatabase(databaseUrl);
  return database;
}

export const db = new Proxy({} as Database, {
  get(_target, property) {
    const currentDatabase = getDatabase();
    const value = Reflect.get(currentDatabase, property, currentDatabase) as unknown;
    return typeof value === "function" ? value.bind(currentDatabase) : value;
  },
});

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Situação do banco para as páginas: só "not_configured" leva para /setup. Falha temporária é tentada de novo uma vez
// (meio segundo depois) antes de ser mostrada como indisponível.
export async function databaseStatus(): Promise<DatabaseStatus> {
  await connection();
  if (!isDatabaseConfigured()) return "not_configured";
  let status: DatabaseStatus = "error";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await getDatabase().execute(sql`select 1`);
      lastLoggedDatabaseFailure = undefined;
      return "ok";
    } catch (error) {
      status = classifyDatabaseError(error);
      const { name, code } = databaseFailureTag(error);
      const failure = `${name}:${code}:${status}`;
      if (lastLoggedDatabaseFailure !== failure) {
        console.error("[crediai:database-healthcheck] PostgreSQL probe failed", { name, code, status, attempt });
        lastLoggedDatabaseFailure = failure;
      }
      if (status !== "unavailable") return status;
      if (attempt === 0) await sleep(500);
    }
  }
  return status;
}

export async function databaseAvailable() {
  return (await databaseStatus()) === "ok";
}
