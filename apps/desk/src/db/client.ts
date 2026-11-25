import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Every session gets server-side limits so nothing can wait forever: a lock wait or a slow query
 * becomes an error, and a transaction left open by a crashed request is killed.
 */
export interface DbTimeouts {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}
export const DEFAULT_DB_TIMEOUTS: DbTimeouts = { statementTimeoutMs: 30_000, lockTimeoutMs: 10_000, idleInTransactionTimeoutMs: 60_000 };

export function connect(url: string, t: DbTimeouts = DEFAULT_DB_TIMEOUTS): { db: Db; close: () => Promise<void> } {
  const client = postgres(url, {
    max: 10,
    onnotice: () => {},
    connect_timeout: 10,
    connection: {
      statement_timeout: t.statementTimeoutMs,
      lock_timeout: t.lockTimeoutMs,
      idle_in_transaction_session_timeout: t.idleInTransactionTimeoutMs,
    },
  });
  return { db: drizzle(client, { schema }), close: () => client.end({ timeout: 5 }) };
}

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
