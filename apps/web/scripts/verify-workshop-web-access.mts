import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createWorkshopMcpServer } = await import("../lib/workshops/mcp-tools");
const { getWorkshop } = await import("../lib/workshops/service");
const { decideLoopActionApproval } = await import("../lib/loops/approval");
const workId = process.argv[2];
if (!workId) throw new Error("workshop id required");
const snapshot = await fetch(`http://127.0.0.1:3515/api/workshops/${workId}/loops`).then(r => r.json());
const workshop = await getWorkshop(snapshot.workshop.userId, workId);
if (!workshop) throw new Error("Workshop unavailable");
const server = createWorkshopMcpServer({ workshop, workshopId: workId });
const client = new Client({ name: "web-access-verification", version: "1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.instance.connect(serverTransport);
await client.connect(clientTransport);
let failed = false;
for (const url of ["https://openai.com/news/", "https://ai.meta.com/blog/", "https://huggingface.co/blog", "https://deepmind.google/blog/", "https://research.google/blog/"]) {
  const result = await client.callTool({ name: "webReadPage", arguments: { url, maxChars: 3000, preferReader: false } });
  const text = (result.content as Array<{ text?: string }>).map(x => x.text || "").join("\n");
  if (result.isError) { failed = true; console.log(JSON.stringify({ url, error: text })); continue; }
  const page = JSON.parse(text);
  console.log(JSON.stringify({ url, method: page.method, finalUrl: page.finalUrl, length: page.content.length, sample: page.content.slice(0,180), warnings: page.warnings, sourceEventId: page.sourceEventId }));
  if (page.content.length < 800) failed = true;
}
console.log(JSON.stringify({ searchGate: decideLoopActionApproval({ actionName: "mcp__workshop-tools__webSearch", actionPolicy: {}, approvalPolicy: { defaultMode: "allow", externalWrites: "require_approval" } }) }));
const search = await client.callTool({ name: "webSearch", arguments: { query: "Hugging Face blog", limit: 3 } });
console.log(JSON.stringify({ searchError: search.isError ?? false, result: JSON.stringify(search.content).slice(0,1200) }));
await client.close();
await server.instance.close();
process.exit(failed ? 1 : 0);
