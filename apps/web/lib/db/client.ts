import { config } from "dotenv";
import { AsyncLocalStorage } from "node:async_hooks";
import { initDb, type getDb } from "./adapters";

config({
  path: ".env",
});

let dbInstance: ReturnType<typeof getDb> | null = null;

export function getDbInstance() {
  if (!dbInstance) {
    dbInstance = initDb();
  }
  return dbInstance;
}

let cachedDb: ReturnType<typeof getDb> | null = null;
const transactionScope = new AsyncLocalStorage<ReturnType<typeof getDb>>();

/** All awaited repository calls in work use this transaction, including nested domain writes.
 * Keep network/model calls outside; never detach work from this scope.
 */
export async function withDatabaseTransaction<T>(work: () => Promise<T>): Promise<T> {
  return db.transaction(async (transaction: any) =>
    transactionScope.run(transaction, work),
  ) as Promise<T>;
}

export const db: ReturnType<typeof getDb> = new Proxy({} as any, {
  get(_target, prop) {
    const transaction = transactionScope.getStore();
    if (transaction) {
      const member = Reflect.get(transaction, prop, transaction);
      return typeof member === 'function' ? member.bind(transaction) : member;
    }
    if (!cachedDb) {
      console.log("[DB] Initializing database connection (first access)...");
      try {
        cachedDb = getDbInstance();
        console.log("[DB] Database initialized successfully");
      } catch (error) {
        console.error("[DB] Failed to initialize database:", error);
        throw error;
      }
    }

    // @ts-ignore - proxy to db instance
    return cachedDb[prop];
  },
});
