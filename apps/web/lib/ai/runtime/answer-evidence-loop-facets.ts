import type { EvidenceReceipt } from "./answer-evidence-contract";

const leaseKeys = ["lease_matches_run", "lease_unexpired", "lease_until", "lease_phase"] as const;
const heartbeatKeys = ["heartbeat_at", "heartbeat_age_ms", "heartbeat_fresh", "maximum_heartbeat_age_ms"] as const;
export type LoopRuntimeFacet = typeof leaseKeys[number] | typeof heartbeatKeys[number];
type Fact = EvidenceReceipt["facts"][number];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const validTime = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));
const unknown = (key: LoopRuntimeFacet): Fact => ({ key, value: null, state: "unknown" });
const observed = (key: LoopRuntimeFacet, value: unknown): Fact => ({ key, value, state: "observed" });

/** Facets select presentation only; the session still enforces its exact Loop subject and read-only scope. */
export function requestedLoopRuntimeFacets(question: string): LoopRuntimeFacet[] {
  const lease = /租约|\bleases?\b|\blease(?:MatchesRun|Unexpired|Until|Phase)\b/iu.test(question);
  const heartbeat = /心跳|\bheart[\s-]?beats?\b|\bheartbeat(?:At|AgeMs|Fresh)\b|\bmaximumHeartbeatAgeMs\b/iu.test(question);
  return [...(lease ? leaseKeys : []), ...(heartbeat ? heartbeatKeys : [])];
}

/** Accept only structured host-reader fields; draft prose never supplies a missing fact. */
export function projectLoopRuntimeFacets(value: unknown): Fact[] {
  const runtime = object(value), linked = object(runtime.linkedExecution);
  const facts = new Map<LoopRuntimeFacet, Fact>([...leaseKeys, ...heartbeatKeys].map(key => [key, unknown(key)]));
  if (runtime.observationScope !== "linked_execution_and_matching_lease" || !validTime(runtime.observedAt)) return [...facts.values()];
  const observedMs = Date.parse(runtime.observedAt);
  if (typeof linked.leaseMatchesRun === "boolean") facts.set("lease_matches_run", observed("lease_matches_run", linked.leaseMatchesRun));
  if (typeof linked.leasePhase === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(linked.leasePhase)) {
    facts.set("lease_phase", observed("lease_phase", linked.leasePhase));
  }
  if (validTime(linked.leaseUntil)) {
    facts.set("lease_until", observed("lease_until", linked.leaseUntil));
    if (typeof linked.leaseUnexpired === "boolean" && linked.leaseUnexpired === (Date.parse(linked.leaseUntil) > observedMs)) {
      facts.set("lease_unexpired", observed("lease_unexpired", linked.leaseUnexpired));
    }
  }
  const maximumAge = runtime.maximumHeartbeatAgeMs;
  if (typeof maximumAge === "number" && Number.isSafeInteger(maximumAge) && maximumAge > 0) {
    facts.set("maximum_heartbeat_age_ms", observed("maximum_heartbeat_age_ms", maximumAge));
  }
  if (validTime(linked.heartbeatAt) && Date.parse(linked.heartbeatAt) <= observedMs) {
    facts.set("heartbeat_at", observed("heartbeat_at", linked.heartbeatAt));
    const age = observedMs - Date.parse(linked.heartbeatAt);
    if (linked.heartbeatAgeMs === age) {
      facts.set("heartbeat_age_ms", observed("heartbeat_age_ms", age));
      if (facts.get("maximum_heartbeat_age_ms")!.state === "observed" && typeof linked.heartbeatFresh === "boolean"
        && linked.heartbeatFresh === (age <= (maximumAge as number))) {
        facts.set("heartbeat_fresh", observed("heartbeat_fresh", linked.heartbeatFresh));
      }
    }
  }
  return [...facts.values()];
}

const labels: Record<LoopRuntimeFacet, string> = {
  lease_matches_run: "租约与该 Loop 的关联执行记录匹配",
  lease_unexpired: "租约在读取时是否未到期",
  lease_until: "租约到期时间",
  lease_phase: "记录的租约阶段",
  heartbeat_at: "记录的心跳时间",
  heartbeat_age_ms: "读取时的心跳年龄（毫秒）",
  heartbeat_fresh: "心跳在读取时是否较新",
  maximum_heartbeat_age_ms: "心跳新鲜度阈值（毫秒）",
};

export function renderRequestedLoopRuntimeFacets(requested: LoopRuntimeFacet[], receipt?: EvidenceReceipt): string {
  if (!requested.length) return "";
  const facts = new Map(receipt?.facts.map(fact => [fact.key, fact]) ?? []);
  const details = requested.map(key => {
    const fact = facts.get(key);
    if (fact?.state !== "observed") return `${labels[key]}：未知（未核实）`;
    const value = typeof fact.value === "boolean" ? fact.value ? "是" : "否" : String(fact.value);
    const meaning = key === "lease_unexpired" && fact.value === false ? "（读取时已到期）" : "";
    return `${labels[key]}：${value}${meaning}`;
  }).join("；");
  const hasHeartbeat = requested.some(key => heartbeatKeys.includes(key as typeof heartbeatKeys[number]));
  const leaseMatch = facts.get("lease_matches_run");
  const boundary = hasHeartbeat && facts.get("heartbeat_at")?.state === "observed"
    ? leaseMatch?.state !== "observed"
      ? "该租约与该 Loop 关联执行记录的匹配关系未知，不能把所列心跳归为该 Loop 已核实的执行器心跳。单次记录也不能证明心跳持续更新或进程当前在线。"
      : leaseMatch.value === false
        ? "所列心跳来自与该 Loop 关联执行记录不匹配的租约，不能归为该 Loop 已核实的执行器心跳。单次记录也不能证明心跳持续更新或进程当前在线。"
        : "心跳只表示读取时的单次记录，不能证明心跳持续更新或进程当前在线。"
    : "";
  return ` 请求核对的细项：${details}。${boundary}`;
}
