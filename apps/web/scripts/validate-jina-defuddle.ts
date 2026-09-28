import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import { cleanWebPage } from "../lib/ai/web-page-cleaner";

const directory = resolve(process.argv[2] ?? "../../.tmp/web-reader-validation");
const url = "https://blog.csdn.net/qq_31532979/article/details/162139401";
const html = await readFile(resolve(directory, "jina-response.txt"), "utf8");
const cleaned = await cleanWebPage(html, url);
await writeFile(resolve(directory, "clean.md"), cleaned.content, "utf8");
const { document } = parseHTML(html);
const article = document.querySelector("#content_views");
if (!article) throw new Error("CSDN article container missing from fixture");
const headings = Array.from(article.querySelectorAll("h1,h2,h3,h4,h5,h6"))
  .map(node => node.textContent?.trim() ?? "").filter(Boolean);
const codeBlocks = Array.from(article.querySelectorAll("pre code"))
  .map(node => node.textContent?.trim() ?? "").filter(Boolean);
const normalize = (value: string) => value.replace(/\\(?=[.])/g, "").replace(/\s/g, "");
const report = { url, ...cleaned, content: undefined, rawBytes: Buffer.byteLength(html),
  cleanChars: cleaned.content.length,
  headings: headings.map(text => ({ text, retained: normalize(cleaned.content).includes(normalize(text)) })),
  codeBlocks: codeBlocks.map((text, index) => ({ index, chars: text.length, retained: normalize(cleaned.content).includes(normalize(text)) })),
  unwantedPresent: ["扫码支付", "打赏作者", "登录领取", "推荐文章"].filter(text => cleaned.content.includes(text)),
};
await writeFile(resolve(directory, "validation.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.headings.some(row => !row.retained) || report.codeBlocks.some(row => !row.retained) || report.unwantedPresent.length) process.exitCode = 1;
