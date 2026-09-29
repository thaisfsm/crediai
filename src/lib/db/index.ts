import "server-only";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

// postgres.js is lazy: this inert DSN is never used unless DATABASE_URL is configured.
const databaseUrl = process.env.DATABASE_URL || "postgres://not-configured:not-configured@127.0.0.1:1/not-configured";
const client = postgres(databaseUrl, { max: 10, prepare: false, connect_timeout: 3 });

export const databaseConfigured = Boolean(process.env.DATABASE_URL);
export const db = drizzle(client, { schema });

export async function databaseAvailable() {
  if (!databaseConfigured) return false;
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
