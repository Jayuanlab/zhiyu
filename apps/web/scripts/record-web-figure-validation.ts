import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readWebFigure } from "../lib/ai/web-figure-reader";
import { figureHash } from "../lib/ai/web-figures";

// These observations were made by visually inspecting these exact PNG hashes.
// This script replays the review record; it is not an automated vision model.
const reviewed: Record<string, string> = {
  "41913299ff64660e87b19fc2d427ad6e0c49909bcfc02a337a6dfda24223e905": "图中为从左到右的串联流程：输入序列 → 输入嵌入与位置编码 → 编码器 × N → 编码器输出 → 解码器 × N → 线性层与 Softmax → 输出序列。各相邻方框有向右箭头。该图是简化示意，没有展示解码器其他输入或内部细节，不能据此补出图中未画出的连接。",
  "142faed50bf9fce02a535f868f5d9b5d8f345074b560c9111e66d8a8ca7f73aa": "图中输入嵌入 X 经 W_Q、W_K、W_V 线性变换分成 Q、K、V 三支。Q 与 K 的箭头汇入 QK^T，随后依次经过 1/√d_k 缩放、Softmax、注意力权重矩阵。V 支绕过这条计算链，与权重矩阵共同汇入加权求和，再输出自注意力结果。中文标签、分支和箭头可见；图中没有展示多头拼接或掩码，不将它们当作图中事实。",
};
const directory = resolve("../../.tmp/web-reader-validation");
const report = JSON.parse(await readFile(resolve(directory, "figure-smoke.json"), "utf8"));
const records = [];
for (const figure of report.rendered) {
  const hash = figureHash(await readFile(figure.imagePath));
  if (hash !== figure.imageHash || !reviewed[hash]) throw Error("Image differs from manually reviewed fixture; inspect it before recording");
  const result = await readWebFigure({ url: figure.source, scope: "validation:figures", evidenceId: report.evidenceId,
    figureId: figure.figureId, description: reviewed[hash], provenance: "codex_visual_review_of_exact_png_2026-09-24" }, { root: resolve(directory, "figure-evidence") });
  records.push(result.metadata);
}
await writeFile(resolve(directory, "figure-visual-review.json"), JSON.stringify(records, null, 2), "utf8");
console.log(JSON.stringify({ recorded: records.length, statuses: records.map(record => record.status) }));
