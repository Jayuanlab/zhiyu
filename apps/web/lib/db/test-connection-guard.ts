/** Refuse ambient developer credentials in tests, including direct adapter imports. */
export function assertTestDatabaseConnection(kind: "postgres" | "sqlite", target: string) {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") return;
  if (kind === "sqlite" && target === ":memory:") return;
  if (kind === "postgres" && process.env.ZHIYU_TEST_MODE === "integration") {
    const configured = process.env.ZHIYU_TEST_DATABASE_URL;
    if (configured && target === configured) {
      const url = new URL(configured);
      if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
          /^\/zhiyu_test_[a-z0-9_]+$/.test(url.pathname)) return;
    }
  }
  // Never include the target: connection strings can contain secrets.
  throw new Error("TEST_DATABASE_BLOCKED: inject an in-memory adapter or an explicit isolated integration database");
}
