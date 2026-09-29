import "server-only";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { connection } from "next/server";
import * as schema from "./schema";

function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 10, prepare: false, connect_timeout: 3 });
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

export async function databaseAvailable() {
  await connection();
  if (!isDatabaseConfigured()) return false;
  try {
    await getDatabase().execute(sql`select 1`);
    lastLoggedDatabaseFailure = undefined;
    return true;
  } catch (error) {
    const name = error instanceof Error ? error.name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) : "UnknownError";
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)
      : "UNKNOWN";
    const failure = `${name}:${code}`;
    if (lastLoggedDatabaseFailure !== failure) {
      console.error("[crediai:database-healthcheck] PostgreSQL probe failed", { name, code });
      lastLoggedDatabaseFailure = failure;
    }
    return false;
  }
}
