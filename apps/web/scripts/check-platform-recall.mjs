import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

for (const name of [path.resolve("../../.env"), ".env", ".env.local"]) {
  if (!fs.existsSync(name)) continue;
  for (const [key, value] of Object.entries(parse(fs.readFileSync(name)))) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function readIdentity() {
  const response = await fetch("http://127.0.0.1:3515/api/identity", {
    headers: { Origin: "http://127.0.0.1:3515" },
  });
  if (!response.ok) {
    throw new Error(`identity_http_${response.status}`);
  }
  const payload = await response.json();
  if (!payload?.actorId) {
    throw new Error("missing_actor_id");
  }
  return payload.actorId;
}

const startedAt = Date.now();
const userId = await readIdentity();
const { recallPlatformInformationForUser } = await import(
  "../lib/ai/platform-recall.ts"
);
const { createNativePiWebChatTools } = await import(
  "../lib/ai/native-pi-web-chat-tools.ts"
);

const result = await recallPlatformInformationForUser({
  userId,
  question: "What platform information can memory retrieve?",
  sections: [
    "registry",
    "architecture",
    "works",
    "loops",
    "brain",
    "knowledge",
    "tools",
  ],
  limit: 20,
});

const platformTool = createNativePiWebChatTools({
  userId,
  policy: { allowedTools: ["platformRecall"], defaultDecision: "deny" },
}).find((tool) => tool.name === "platformRecall");
if (!platformTool) {
  throw new Error("platform_recall_tool_missing");
}
const toolResult = await platformTool.execute(
  "platform-recall-live-check",
  {
    question: "What platform information can memory retrieve?",
    sections: ["registry", "architecture", "works", "loops", "brain", "tools"],
    limit: 10,
  },
  undefined,
);
const toolPayload = toolResult.details?.result ?? {};

const data = result.data ?? {};
const report = {
  at: new Date().toISOString(),
  userId,
  ok: result.ok,
  sections: result.sections,
  warnings: result.warnings,
  counts: {
    registry: Array.isArray(data.registry) ? data.registry.length : 0,
    architecture:
      typeof data.architecture === "object" && data.architecture
        ? data.architecture.count ?? 0
        : 0,
    works:
      typeof data.works === "object" &&
      data.works &&
      Array.isArray(data.works.workshops)
        ? data.works.workshops.length
        : 0,
    loops:
      typeof data.loops === "object" &&
      data.loops &&
      Array.isArray(data.loops.data?.loops)
        ? data.loops.data.loops.length
        : 0,
    snapshots:
      typeof data.brain === "object" &&
      data.brain &&
      Array.isArray(data.brain.snapshots)
        ? data.brain.snapshots.length
        : 0,
    grants:
      typeof data.brain === "object" &&
      data.brain &&
      Array.isArray(data.brain.grants)
        ? data.brain.grants.length
        : 0,
    knowledgeDocuments:
      typeof data.knowledge === "object" &&
      data.knowledge &&
      Array.isArray(data.knowledge.documents)
        ? data.knowledge.documents.length
        : 0,
    tools:
      typeof data.tools === "object" &&
      data.tools &&
      Array.isArray(data.tools.tools)
        ? data.tools.tools.length
        : 0,
  },
  ownerIsolation: {
    architecture:
      typeof data.architecture === "object" &&
      data.architecture &&
      Array.isArray(data.architecture.memories)
        ? data.architecture.memories.every((memory) => memory.id)
        : false,
  },
  tool: {
    status: toolResult.details?.trace?.status ?? null,
    name: platformTool.name,
    ok: toolPayload.ok === true,
    registryVersion: toolPayload.registryVersion ?? null,
    sections: toolPayload.sections ?? [],
  },
  ms: Date.now() - startedAt,
};

const outputDir = path.resolve("../../.runtime/platform-recall");
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  path.join(outputDir, "latest-check.json"),
  JSON.stringify(report, null, 2),
  "utf8",
);
console.log(JSON.stringify(report));

process.exit(
  result.ok &&
    report.counts.registry >= 6 &&
    report.tool.status === "completed" &&
    report.tool.ok
    ? 0
    : 1,
);
