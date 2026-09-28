import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import {
  createPiLocalTools,
  stagePiWorkshopFileSources,
} from "../lib/workshops/pi-local-tools";

const root = await mkdtemp(join(tmpdir(), "zhiyu-pi-smoke-"));
try {
  const sourcePath = join(root, "source.csv");
  await writeFile(sourcePath, "id,value\n1,10\n1,10\n2,20\n", "utf8");
  const staged = await stagePiWorkshopFileSources(root, [{
    id: "source-1", type: "file", enabled: true, uri: sourcePath,
  } as any]);
  if (staged.staged.length !== 1 || staged.warnings.length) throw Error("Source staging failed");
  const tools = createPiLocalTools(root);
  const scriptPath = join(root, "clean.py");
  const script = [
    "import csv, sys",
    "with open(sys.argv[1], newline='', encoding='utf-8') as source:",
    "    rows = list(csv.DictReader(source))",
    "with open(sys.argv[2], 'w', newline='', encoding='utf-8') as output:",
    "    writer = csv.DictWriter(output, fieldnames=['id', 'value'])",
    "    writer.writeheader()",
    "    writer.writerows({tuple(row.items()): row for row in rows}.values())",
  ].join("\n");
  const outputPath = join(root, "cleaned.csv");
  const command = `python "${scriptPath}" "${staged.staged[0].runPath}" "${outputPath}"`;
  const shell = process.platform === "win32" ? "PowerShell" : "Bash";
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: scriptPath, content: script }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall(shell, { command, timeout: 20_000 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Read", { path: outputPath }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Cleaning complete"),
  ]);
  const runtime = createPiAgentRuntime({
    adapter: "harness", model: faux.getModel(), streamFn: faux.streamSimple, tools,
  });
  const events = [];
  for await (const event of runtime.run({ operation: "run", prompt: "Clean the staged source" })) events.push(event);
  const output = await readFile(outputPath, "utf8");
  if (output.trim().split(/\r?\n/).length !== 3) {
    throw Error(`Unexpected cleaned output: ${output}; events=${JSON.stringify(events)}`);
  }
  if (!events.some(event => event.type === "tool_result" && event.isError === false && event.output.includes("id,value"))) {
    throw Error(`Pi did not inspect the cleaned file: ${JSON.stringify(events)}`);
  }
  process.stdout.write(JSON.stringify({ ok: true, shell, sourceRows: 3, outputRows: 2 }) + "\n");
} finally {
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("zhiyu-pi-smoke-")) {
    throw Error("Unexpected smoke cleanup path");
  }
  await rm(target, { recursive: true, force: true });
}
