import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readJinaDefuddlePage, webEvidenceDirectory } from "../lib/ai/jina-page-reader";
import { readWebFigure } from "../lib/ai/web-figure-reader";

const dir = resolve("../../.tmp/web-reader-validation");
const html = await readFile(resolve(dir, "retry-html.html"), "utf8");
const root = resolve(dir, "figure-evidence");
const scope = "validation:figures";
const url = "https://blog.csdn.net/qq_31532979/article/details/162139401";
// Replay the previously fetched real Jina HTML to isolate extraction/render changes.
const page = await readJinaDefuddlePage({ url, scope, maxChars: 30000 }, { root, fetcher: async () => new Response(html) });
await writeFile(resolve(dir, "clean-with-figures.md"), page.content, "utf8");
const reports: unknown[] = [];
for (const figure of page.figures.filter(f => f.kind === "svg" && f.labels.length > 20).slice(0, 2)) {
  const result = await readWebFigure({ url, scope, evidenceId: page.evidenceId, figureId: figure.id }, { root });
  reports.push({ ...result.metadata, imagePath: resolve(webEvidenceDirectory(scope, page.evidenceId, root), `${figure.id}.png`), imageBytes: Buffer.from(result.image!.data, "base64").length });
}
if (reports.length !== 2) throw Error("Expected two substantive SVG figures");
const report = { inputMode: "replay_saved_real_jina_html", evidenceId: page.evidenceId, figures: page.figures, rendered: reports };
await writeFile(resolve(dir, "figure-smoke.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
