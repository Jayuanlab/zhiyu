/**
 * PostgreSQL database adapter
 * For server deployment
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema.pg";
import type { DrizzleDB } from "../types";
import { assertTestDatabaseConnection } from "../test-connection-guard";

let db: DrizzleDB | null = null;
let client: postgres.Sql | null = null;

/**
 * Initialize PostgreSQL database connection
 */
export function initPostgresDb(connectionString: string): DrizzleDB {
  assertTestDatabaseConnection("postgres", connectionString);
  if (db) {
    return db;
  }

  if (!connectionString) {
    throw new Error(
      "POSTGRES_URL or DATABASE_URL environment variable is required",
    );
  }

  // Create PostgreSQL connection
  client = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  // Create Drizzle instance and cast to DrizzleDB type
  db = drizzle(client, { schema }) as unknown as DrizzleDB;

  console.log("✅ PostgreSQL database initialized");

  return db;
}

/**
 * Get database instance
 */
export function getPostgresDb(): DrizzleDB {
  if (!db) {
    throw new Error(
      "PostgreSQL database not initialized. Call initPostgresDb first.",
    );
  }
  return db;
}

/**
 * Close database connection
 */
export async function closePostgresDb() {
  if (client) {
    await client.end();
    client = null;
    db = null;
    console.log("🔒 PostgreSQL database closed");
  }
}

/**
 * Check if database is initialized
 */
export function isPostgresDbInitialized(): boolean {
  return db !== null;
}
