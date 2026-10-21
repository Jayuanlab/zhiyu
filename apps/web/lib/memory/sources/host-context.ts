import type { ExactUsePolicy } from "../context/exact-use-admission";
import { admitSourceRows } from "./registration";
import type { PlatformSourceName } from "./catalog";

/** Host-owned rows already selected for the actual prompt. No model-provided
 * IDs, table names or output callbacks are used as a version or permission. */
export async function admitHostSourceRows(policy: ExactUsePolicy, source: PlatformSourceName, rows: readonly object[]) {
  await admitSourceRows({ policy, source, rows: rows.map(row => Object.fromEntries(Object.entries(row))) });
}
