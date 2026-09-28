import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readJinaDefuddlePage } from "../lib/ai/jina-page-reader";

const directory = resolve("../../.tmp/web-reader-validation");
await mkdir(directory, { recursive: true });
const first = await readJinaDefuddlePage({
  url: "https://blog.csdn.net/qq_31532979/article/details/162139401", scope: "validation:csdn", maxChars: 3000,
}, { root: resolve(directory, "evidence") });
const remainder = await readJinaDefuddlePage({ url: first.url, scope: "validation:csdn", evidenceId: first.evidenceId,
  offset: first.nextOffset!, maxChars: 30000 }, { root: resolve(directory, "evidence"), fetcher: async () => { throw Error("Continuation must not fetch"); } });
const report = { first: { ...first, content: undefined }, continuation: { ...remainder, content: undefined },
  tailFound: remainder.content.includes("总结"), reconstructedChars: first.content.length + remainder.content.length };
await writeFile(resolve(directory, "live-smoke.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
if (!report.tailFound || report.reconstructedChars !== first.totalChars) throw Error("Continuation validation failed");
