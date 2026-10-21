import { createHash } from "node:crypto";

export const PLATFORM_SOURCE_DISCOVERY_VERSION = "platform-source-discovery.v2-focused";

/** Published discovery labels, never a substitute for reading the source. */
export const PLATFORM_SOURCE_METADATA: Record<string, { title: string; purpose: string; topics: string[] }> = {
  "docs/architecture/zhiyu-control-architecture-contract.md": {
    title: "平台控制架构 / Platform control architecture",
    purpose: "Discover controller roles, observations, state, feedback and review boundaries.",
    topics: ["platform architecture", "控制架构", "角色边界", "审核", "核心配置", "配置变更", "配置版本"],
  },
  "docs/adr/0001-scope-memory-recall-policy.md": {
    title: "记忆范围设计 / Memory scope design",
    purpose: "Find the design contract for memory ownership, scopes and recall policy.",
    topics: ["memory scope", "记忆范围", "读取授权", "记忆召回"],
  },
  "apps/web/lib/memory/revision/policy.ts": {
    title: "记忆授权检查 / Memory permission checks",
    purpose: "Inspect the implemented memory read and grant predicates.",
    topics: ["memory permissions", "记忆权限", "读取授权", "grant"],
  },
  "apps/web/lib/memory/kernel/memory-types.ts": {
    title: "记忆状态类型 / Memory state types",
    purpose: "Inspect structured memory, source and scope representations.",
    topics: ["memory types", "记忆类型", "memory scope", "记忆范围"],
  },
  "apps/web/lib/memory/context/pack.ts": {
    title: "记忆上下文选择 / Memory context selection",
    purpose: "Find memory selection and filtering for an execution context.",
    topics: ["memory retrieval", "记忆检索", "context selection", "上下文选择", "自动补查", "查询改写", "计划范围"],
  },
  "apps/web/lib/memory/retrieval/recall-planner.ts": {
    title: "记忆召回规划 / Memory recall planning",
    purpose: "Inspect recall planning and source selection.",
    topics: ["memory retrieval", "memory recall", "记忆召回", "记忆检索"],
  },
  "apps/web/lib/memory/retrieval/recall.ts": {
    title: "记忆服务 / Memory service",
    purpose: "Inspect memory service entry points and operations.",
    topics: ["memory service", "记忆服务"],
  },
  "apps/web/lib/memory/evidence/reader.ts": {
    title: "记忆证据读取 / Memory evidence reader",
    purpose: "Find bounded evidence expansion and provenance handling.",
    topics: ["memory evidence", "记忆证据", "来源证据", "source trace"],
  },
  "apps/web/lib/ai/runtime/tool-executor.ts": {
    title: "工具执行权限 / Runtime tool permissions",
    purpose: "Inspect tool admission and execution checks; this source grants no authority.",
    topics: ["tool permissions", "工具权限", "工具授权", "authorization", "denied"],
  },
  "docs/architecture/workshop-workspace-model.md": {
    title: "车间、Loop 与运行空间 / Workshop workspace model",
    purpose: "Find workspace ownership, file lifecycle, retained artifacts and their relation to registered sources and knowledge ingestion.",
    topics: ["workshop workspace", "工作空间", "运行空间", "persistent artifacts", "长期成果目录", "source registration", "资料登记", "knowledge ingestion", "知识纳入"],
  },
  "apps/web/lib/workshops/runtime-run-snapshot.ts": {
    title: "运行配置快照 / Runtime configuration snapshot",
    purpose: "Inspect how a run snapshot is selected from recorded events; code alone does not prove any target run's loaded configuration.",
    topics: ["runtime configuration", "运行时配置", "实际加载", "运行快照", "runtimeRunSnapshot", "agent_configured"],
  },
  "docs/architecture/engineering-cybernetics-guiding-principles.md": {
    title: "工程控制与可观测原则 / Engineering observations",
    purpose: "Read the design requirements for input freshness, tool evidence, run status, next wakeup, heartbeat and human intervention; requirements do not prove runtime implementation.",
    topics: ["observability", "可观测", "已启动", "输入新鲜度", "工具结果", "模型依据", "下次运行", "心跳", "工程控制"],
  },
  "skills/agent-evolution/SKILL.md": {
    title: "智能体更新方法 / Agent evolution method",
    purpose: "Read evidence-backed update and evaluation methods, authorization limits, version readback and rollback; a method grants no permissions.",
    topics: ["agent evolution", "智能体进化", "智能体更新", "skill", "自评分", "保存", "装载", "生产效果"],
  },
  "apps/web/lib/memory/retrieval/query-retry.ts": {
    title: "检索补查与查询改写 / Retrieval follow-up",
    purpose: "Inspect the bounded follow-up query implementation and how original requirements constrain it.",
    topics: ["query rewrite", "查询改写", "自动补查", "补充查询", "原计划范围"],
  },
  "apps/web/lib/loops/document-artifact-verifier.ts": {
    title: "文档产物程序检查 / Artifact checks",
    purpose: "Inspect deterministic artifact and format checks; program checks do not establish domain correctness or owner acceptance.",
    topics: ["artifact verification", "产物检查", "程序检查", "格式检查", "验证结果", "验收"],
  },
  "apps/web/lib/workshops/codebase-read.ts": {
    title: "有界仓库只读 / Bounded repository reading",
    purpose: "Inspect read-only repository authorization and traversal boundaries; reading does not authorize configuration changes.",
    topics: ["codebase read", "仓库只读", "代码读取", "读取授权", "codebaseRead"],
  },
  "manifests/workshops/paper-trader.workshop.yaml": {
    title: "操盘交易员角色模板 / Paper trader role",
    purpose: "Read the trader template's controlled object and role limits; a template does not prove an owner's loaded configuration.",
    topics: ["paper trader", "操盘交易员", "模拟交易", "自选股", "角色分工"],
  },
  "manifests/workshops/watchlist-hunter.workshop.yaml": {
    title: "自选股猎手角色模板 / Watchlist hunter role",
    purpose: "Read the watchlist pool controller template and its boundary with trading.",
    topics: ["watchlist hunter", "自选股猎手", "自选股池", "候选池", "角色分工"],
  },
  "apps/web/lib/quant/control-guards.ts": {
    title: "行情质量与候选池保护 / Data quality guards",
    purpose: "Inspect conditional data-quality guards, the guarded target and fallback/source-switch exceptions; this source does not establish all trading paths.",
    topics: ["data quality", "行情质量", "降级", "fallback", "sourceSwitch", "候选池", "持久化"],
  },
};

// These are ordinary platform terms in both languages, not evaluation labels.
const conceptAliases = {
  workspace: ["workshop workspace", "workspace", "工作空间", "运行空间"],
  artifacts: ["persistent artifacts", "retained artifacts", "long-term artifacts", "artifacts", "长期成果", "长期产物", "成果目录"],
  registration: ["source registration", "registered sources", "资料登记", "资料注册", "登记资料"],
  ingestion: ["knowledge ingestion", "knowledge promotion", "knowledge base", "知识摄取", "知识纳入", "知识库"],
  run_configuration: ["runtime configuration", "runtime config", "loaded configuration", "loaded config", "runtime snapshot", "runtimeRunSnapshot", "agent_configured", "运行配置", "运行时配置", "实际加载", "配置装载", "运行快照"],
  memory_scope: ["memory scope", "记忆范围"],
  memory_permissions: ["memory permissions", "memory permission", "memory grant", "记忆权限", "读取授权"],
  memory_retrieval: ["memory retrieval", "memory recall", "记忆检索", "记忆召回"],
  memory_evidence: ["memory evidence", "source trace", "记忆证据", "来源证据"],
  tool_permissions: ["tool permissions", "tool permission", "tool authorization", "工具权限", "工具授权"],
  configuration_change: ["core configuration", "核心配置", "配置变更", "配置修改", "配置版本"],
  engineering_observation: ["observability", "可观测", "已启动", "输入新鲜度", "工具结果", "模型依据", "工程控制"],
  agent_evolution: ["agent evolution", "智能体进化", "智能体更新", "自评分", "skill"],
  query_followup: ["query rewrite", "查询改写", "自动补查", "补充查询", "计划范围"],
  data_quality: ["data quality", "行情质量", "降级", "fallback", "sourceSwitch"],
} as const;
const normalized = (value: string) => value.normalize("NFKC").toLowerCase();
const stopWords = new Set(["the", "and", "for", "with", "from", "what", "which", "does", "this", "that", "have", "has", "are", "can", "how", "why", "into", "was", "were"]);
const lexicalTerms = (value: string) => {
  const terms = normalized(value).match(/[a-z0-9_./-]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  const result: string[] = [];
  for (const term of terms) {
    if (stopWords.has(term)) continue;
    if (/^[\u4e00-\u9fff]+$/.test(term) && term.length > 3) {
      for (let offset = 0; offset < term.length - 1; offset++) result.push(term.slice(offset, offset + 2));
    } else result.push(term);
  }
  return [...new Set(result)].slice(0, 48);
};

export type PlatformSourceCandidate = { sourceId: string; path: string; content: string; sourceHash: string };

export function platformSourceMetadata(sourcePath: string) {
  return Object.hasOwn(PLATFORM_SOURCE_METADATA, sourcePath) ? PLATFORM_SOURCE_METADATA[sourcePath] : undefined;
}

/** Rank only the caller's already authorized/captured sources. No I/O or permissions. */
export function rankPlatformSourceCandidates(sources: readonly PlatformSourceCandidate[], query: string, limit = 8) {
  if (typeof query !== "string" || !query.trim() || query.length > 1000) throw Error("Invalid platform source query");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12) throw Error("Invalid platform source search limit");
  const queryText = normalized(query.trim());
  const concepts = Object.entries(conceptAliases).filter(([, aliases]) => aliases.some(alias => queryText.includes(normalized(alias))));
  const words = new Set(queryText.match(/[a-z]+/g) ?? []);
  const configurationLifecycle = (["config", "configuration"].some(word => words.has(word))
    && ["load", "loaded", "runtime", "running", "snapshot"].some(word => words.has(word)))
    || (/配置/.test(queryText) && /加载|装载|运行|快照/.test(queryText));
  if (configurationLifecycle && !concepts.some(([topic]) => topic === "run_configuration")) concepts.push(["run_configuration", conceptAliases.run_configuration]);
  const terms = [...new Set([...lexicalTerms(queryText), ...concepts.flatMap(([, aliases]) => aliases.map(normalized))])];
  const hitCount = (value: string) => {
    const text = normalized(value);
    return terms.filter(term => text.includes(term)).length;
  };
  const topicHits = (value: string) => {
    const text = normalized(value);
    return concepts.filter(([, aliases]) => aliases.some(alias => text.includes(normalized(alias))));
  };
  return sources.map(source => {
    const metadata = platformSourceMetadata(source.path);
    const lines = source.content.split("\n");
    const heading = lines.find(line => /^#{1,3}\s+/.test(line))?.replace(/^#+\s+/, "").trim();
    const title = metadata?.title ?? heading ?? source.path.split("/").at(-1) ?? source.path;
    const topics = metadata?.topics ?? [];
    const metadataText = [title, ...topics].join(" ");
    const matchedTopics = topicHits(metadataText).map(([topic]) => topic);
    const pathScore = normalized(source.path) === queryText || normalized(source.sourceId) === queryText ? 1000 : Math.min(4, hitCount(source.path)) * 20;
    const metadataScore = matchedTopics.length * 32 + Math.min(4, hitCount(title)) * 12 + Math.min(4, hitCount(topics.join(" "))) * 6;
    let bestLine = -1, bestLineScore = 0;
    lines.forEach((line, index) => {
      const hits = hitCount(line);
      if (!hits) return;
      // A large module cannot win by repeating imports or the same broad word.
      const importLine = /^\s*(?:import\b|export\s+(?:type\s+)?\{.*\}\s+from\b)/.test(line);
      const score = Math.min(8, hits) + topicHits(line).length * 4 + (/^#{1,3}\s+/.test(line) ? 2 : 0) - (importLine ? 5 : 0);
      if (score > bestLineScore) { bestLineScore = score; bestLine = index; }
    });
    const score = pathScore + metadataScore + Math.min(24, bestLineScore);
    if (!score) return null;
    const first = Math.max(0, (bestLine < 0 ? 0 : bestLine) - 2);
    const offset = lines.slice(0, first).reduce((total, line) => total + line.length + 1, 0);
    const contentHash = createHash("sha256").update(source.content).digest("hex");
    const excerpt = lines.slice(first, first + 11).join("\n").slice(0, 600);
    return { sourceId: source.sourceId, path: source.path, sourceHash: source.sourceHash, contentHash,
      title, purpose: metadata?.purpose ?? "Inspect this authorized source for the matched text.", topics,
      score, matchedTopics, matchLine: bestLine < 0 ? null : bestLine + 1,
      startLine: first + 1, endLine: first + excerpt.split("\n").length, excerpt,
      nextRead: { sourceId: source.sourceId, offset, expectedHash: contentHash },
      discoveryVersion: PLATFORM_SOURCE_DISCOVERY_VERSION, metadataRole: "retrieval_lead_only" as const };
  }).filter((result): result is NonNullable<typeof result> => result !== null)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, "en"))
    .slice(0, limit);
}
