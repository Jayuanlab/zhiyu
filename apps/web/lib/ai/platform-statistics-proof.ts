import { createHash } from "node:crypto";
import type { EvidenceObservation } from "@/lib/memory/retrieval/evidence-time";

const definitions = [
  ["workshops", "status", "s.user_id = $1"],
  ["loops", "status", "s.user_id = $1"],
  ["brain_memories", "status", "s.user_id = $1"],
  ["brain_memories", "canonical_kind", "s.user_id = $1"],
  ["interaction_events", "processed_status", "s.user_id = $1"],
  ["interaction_processing_jobs", "status", "s.user_id = $1"],
  ["workshop_outbox", "status", "s.workshop_id IN (SELECT id FROM workshops WHERE user_id = $1)"],
  ["rag_documents", "content_type", "s.user_id = $1"],
  ["user_llm_api_settings", "enabled", "s.user_id = $1"],
  ["harness_components", "component_type", "s.id IN (SELECT id FROM harness_components WHERE scope_type IN ('work', 'workshop') AND scope_id::text IN (SELECT id::text FROM workshops WHERE user_id = $1))"],
  ["harness_component_revisions", "status", "s.component_id IN (SELECT id FROM harness_components WHERE scope_type IN ('work', 'workshop') AND scope_id::text IN (SELECT id::text FROM workshops WHERE user_id = $1))"],
  ["work_commands", "status", "s.owner_id = $1"],
  ["work_run_evidence_bundles", "capture_status", "s.user_id = $1"],
  ["paper_accounts", "version", "s.owner_id = $1"],
  ["paper_orders", "status", "s.account_id IN (SELECT id FROM paper_accounts WHERE owner_id = $1)"],
  ["workshop_heartbeats", "scheduler_status", "s.workshop_id IN (SELECT id FROM workshops WHERE user_id = $1)"],
  ["workshop_heartbeats", "count", "s.workshop_id IN (SELECT id FROM workshops WHERE user_id = $1)"],
] as const;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const normalize = (value: string) => value.replaceAll("_", "").toLowerCase().replace(/^modelconfiguration\./, "userllmapisettings.");
const validTime = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value));
const sourceDefinition = (source: string) => definitions.find(([table, dimension]) => normalize(`${table}.${dimension}`) === normalize(source));
export const canonicalPlatformStatisticSource = (source: string) => {
  const definition = sourceDefinition(source);
  return definition ? `${definition[0]}.${definition[1]}` : null;
};
const contractId = (source: string) => `owner-stored:${source}`;
const predicateHash = (source: string, ownerId: string) => hash({ contract: contractId(source), ownerId, universe: "owner_stored" });
const fixedSql = ([table, dimension, owned]: typeof definitions[number]) => dimension === "count"
  ? `SELECT count(*)::int AS total FROM "${table}" s WHERE ${owned}`
  : `SELECT s."${dimension}" AS value, count(*)::int AS count FROM "${table}" s WHERE ${owned} GROUP BY s."${dimension}" ORDER BY s."${dimension}" NULLS FIRST`;
const normalizeSql = (query: string) => query.trim().replace(/\s+/gu, " ");

export type PlatformStatisticsScopeProof = {
  schemaVersion: "platform-statistics-scope-proof.v1";
  queryContractId: string;
  queryContractVersion: "owner-stored-query.v1";
  universe: "owner_stored";
  authorizationRef: string;
  source: string;
  predicateHash: string;
  queryHash: string;
  observation: EvidenceObservation;
  consistency: "single_query";
  populationCoverage: "complete_query";
  deliveryCoverage: "complete";
  adapter: "live_fixed_query" | "manifest_pinned_fixed_query";
  captureHash?: string;
  resultHash: string;
  proofId: string;
};

function validCounts(source: string, total: unknown, groups: unknown) {
  if (!Number.isSafeInteger(total) || (total as number) < 0) return false;
  if (source.endsWith(".count")) return groups === undefined;
  if (!Array.isArray(groups)) return false;
  const keys = new Set<string>();
  let sum = 0;
  for (const group of groups) {
    if (!group || typeof group !== "object" || !Object.hasOwn(group, "value") || !Number.isSafeInteger(group.count) || group.count < 0) return false;
    const value = group.value;
    if (!(value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value))) return false;
    const key = JSON.stringify([typeof value, value]);
    if (keys.has(key)) return false;
    keys.add(key); sum += group.count;
    if (!Number.isSafeInteger(sum)) return false;
  }
  return sum === total;
}

function buildProof(input: { ownerId: string; source: string; total: unknown; groups?: unknown; observedAt: string },
  adapter: PlatformStatisticsScopeProof["adapter"], queryHash: string, captureHash?: string): PlatformStatisticsScopeProof | undefined {
  const source = canonicalPlatformStatisticSource(input.source);
  if (!source || !input.ownerId || !validTime(input.observedAt) || !validCounts(source, input.total, input.groups)) return undefined;
  const body: Omit<PlatformStatisticsScopeProof, "proofId"> = {
    schemaVersion: "platform-statistics-scope-proof.v1", queryContractId: contractId(source), queryContractVersion: "owner-stored-query.v1",
    universe: "owner_stored", authorizationRef: hash({ ownerId: input.ownerId, policy: "authenticated_owner" }), source,
    predicateHash: predicateHash(source, input.ownerId), queryHash,
    observation: { kind: adapter === "live_fixed_query" ? "live" : "snapshot", observedAt: input.observedAt },
    consistency: "single_query", populationCoverage: "complete_query", deliveryCoverage: "complete", adapter,
    ...(captureHash ? { captureHash } : {}), resultHash: hash({ source, total: input.total, groups: input.groups ?? null }),
  };
  return { ...body, proofId: hash(body) };
}

/** Call only after the registered owner-filtered query completed successfully. */
export function createLivePlatformStatisticsProof(input: { ownerId: string; source: string; total: unknown; groups?: unknown; observedAt: string }) {
  const source = canonicalPlatformStatisticSource(input.source);
  return source ? buildProof(input, "live_fixed_query", hash({ queryContractId: contractId(source), queryContractVersion: "owner-stored-query.v1", adapter: "live_fixed_query" })) : undefined;
}

/** An arbitrary SQL string with GROUP BY is insufficient to prove owner-wide coverage. */
export function createFrozenPlatformStatisticsProof(input: {
  ownerId: string; source: string; total: unknown; groups?: unknown; observedAt: string;
  query: unknown; parameters: unknown; captureHash: string;
}) {
  const definition = sourceDefinition(input.source);
  if (!definition || typeof input.query !== "string" || !Array.isArray(input.parameters)
    || input.parameters.length !== 1 || input.parameters[0] !== input.ownerId
    || normalizeSql(input.query) !== fixedSql(definition) || !/^[a-f0-9]{64}$/u.test(input.captureHash)) return undefined;
  return buildProof(input, "manifest_pinned_fixed_query", hash(normalizeSql(input.query)), input.captureHash);
}

export function validatePlatformStatisticsProof(proof: unknown, input: { ownerId: string; source: string; total: unknown; groups?: unknown }):
  { valid: boolean; reason?: string; proof?: PlatformStatisticsScopeProof } {
  const source = canonicalPlatformStatisticSource(input.source);
  const fail = (reason: string) => ({ valid: false, reason });
  if (!source || !validCounts(source, input.total, input.groups)) return fail("metric_definition_or_counts_invalid");
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return fail("scope_proof_missing");
  const p = proof as PlatformStatisticsScopeProof;
  if (p.schemaVersion !== "platform-statistics-scope-proof.v1" || p.queryContractVersion !== "owner-stored-query.v1"
    || p.source !== source || p.queryContractId !== contractId(source) || p.universe !== "owner_stored"
    || p.authorizationRef !== hash({ ownerId: input.ownerId, policy: "authenticated_owner" }) || p.predicateHash !== predicateHash(source, input.ownerId)
    || p.consistency !== "single_query" || p.populationCoverage !== "complete_query" || p.deliveryCoverage !== "complete") return fail("scope_or_authorization_mismatch");
  if (!validTime(p.observation?.observedAt) || !["live_fixed_query", "manifest_pinned_fixed_query"].includes(p.adapter)) return fail("observation_unknown");
  if (p.adapter === "live_fixed_query") {
    if (p.observation.kind !== "live" || p.captureHash !== undefined || p.queryHash !== hash({ queryContractId: contractId(source), queryContractVersion: "owner-stored-query.v1", adapter: "live_fixed_query" })) return fail("query_contract_mismatch");
  } else if (p.observation.kind !== "snapshot" || !/^[a-f0-9]{64}$/u.test(p.captureHash ?? "") || p.queryHash !== hash(fixedSql(sourceDefinition(source)!))) return fail("capture_or_query_mismatch");
  if (p.resultHash !== hash({ source, total: input.total, groups: input.groups ?? null })) return fail("metric_result_mismatch");
  const { proofId, ...body } = p;
  if (proofId !== hash(body)) return fail("scope_proof_changed");
  return { valid: true, proof: p };
}
