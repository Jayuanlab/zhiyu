import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";
import { cleanWebPage } from "../lib/ai/web-page-cleaner";

const directory = resolve("../../.tmp/web-reader-validation");
const url = "https://blog.csdn.net/qq_31532979/article/details/162139401";
const html = await readFile(resolve(directory, "retry-html.html"), "utf8");
if (!/<html[\s>]/i.test(html)) throw Error("Expected HTML response");
// Feed an unmodified DOM to the upstream library with Markdown output enabled.
const { document } = parseHTML(html);
const original = await Defuddle(document as unknown as Document, url, { markdown: true });
const customized = await cleanWebPage(html, url);
await writeFile(resolve(directory, "defuddle-original.md"), original.content, "utf8");
await writeFile(resolve(directory, "defuddle-custom-retry.md"), customized.content, "utf8");
const summarize = (content: string) => ({
  chars: content.length,
  codeFences: (content.match(/^```/gm) ?? []).length,
  svgTags: (content.match(/<svg[\s>]/g) ?? []).length,
  codeToolbarResidue: content.includes("python\u8fd0\u884c123"),
  mathToolbarResidue: content.includes("math1"),
  tailFound: content.includes("\u603b\u7ed3"),
});
const report = { url, fetchedAt: new Date().toISOString(), rawBytes: Buffer.byteLength(html),
  title: original.title, original: summarize(original.content), customized: summarize(customized.content) };
await writeFile(resolve(directory, "defuddle-comparison.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
