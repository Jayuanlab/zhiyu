import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAndBuildGroundedResearchReport, type GroundedResearchClaim, type GroundedResearchReportInput } from "@/lib/workshops/grounded-research-report";
import { researchClaimConditionIssues } from "@/lib/workshops/research-claim-conditions";

type Claim = Pick<GroundedResearchClaim, "kind" | "claim" | "quote">;
// Exact claim/quote and paragraph pairs from the independent same-version
// review of run 41c373d7-a677-8160-a76b-fe1a835b04c6. These small offline
// fixtures neither impersonate production receipts nor certify scientific truth.
const method: Claim = {
  kind: "method",
  claim: "提出自原则批评调优（SPCT）方法，通过在线强化学习培养通用奖励模型的可扩展奖励生成行为，自适应生成原则并准确生成批评。",
  quote: "For the learning method, we propose Self-Principled Critique Tuning (SPCT) to foster scalable reward generation behaviors in GRMs through online RL, to generate principles adaptively and critiques accurately, resulting in DeepSeek-GRM models.",
};
const methodParagraph = "Reinforcement learning (RL) has been widely adopted in post-training for large language models (LLMs) at scale. Recently, the incentivization of reasoning capabilities in LLMs from RL indicates that *proper learning methods could enable effective inference-time scalability*. A key challenge of RL is to obtain accurate reward signals for LLMs in various domains beyond verifiable questions or artificial rules. In this work, we investigate how to improve reward modeling (RM) with more inference compute for general queries, i.e. the inference-time scalability of generalist RM, and further, how to improve the effectiveness of performance-compute scaling with proper learning methods. For the RM approach, we adopt pointwise generative reward modeling (GRM) to enable flexibility for different input types and potential for inference-time scaling. " + method.quote + " Furthermore, for effective inference-time scaling, we use parallel sampling to expand compute usage, and introduce a meta RM to guide voting process for better scaling performance. Empirically, we show that SPCT significantly improves the quality and scalability of GRMs, outperforming existing methods and models in various RM benchmarks without severe biases, and could achieve better performance compared to training-time scaling. DeepSeek-GRM still meets challenges in some tasks, which we believe can be addressed by future efforts in generalist reward systems. The models will be released and open-sourced.";
const experiment: Claim = {
  kind: "experiment",
  claim: "DeepSeek-GRM-27B 使用 32 个样本直接投票可达到与 671B MoE 模型相当的性能，meta RM 引导投票使用 8 个样本可达到最佳结果。",
  quote: "We find that direct voting with 32 samples of DeepSeek-GRM-27B could achieve comparable performance with the 671B MoE model, and the meta RM guided voting could achieve the best results with 8 samples, demonstrating the effectiveness of inference-time scaling of DeepSeek-GRM-27B compared to scaling model sizes.",
};
const benchmarkCondition = "The models are tested on the Reward Bench, and the results are shown in Figure 4.";
const experimentParagraph = "Scaling Inference and Training Costs We further investigate the inference-time and training-time scaling performance of DeepSeek-GRM-27B, by post-training with LLMs in different sizes. " + benchmarkCondition + " " + experiment.quote + " Moreover, we test DeepSeek-R1 with a downsampled test set containing 300 samples, and find its performance even worse than the 236B MoE RFT model, indicating that expanding long chain-of-thoughts for reasoning tasks could not significantly improve the performance of generalist RM.";
const baseline: Claim[] = [
  { kind: "method", claim: "该方法从组得分估计基线。", quote: "The method estimates a baseline using the scores from a group of samples." },
  { kind: "experiment", claim: "实验比较了指定的基线设置。", quote: "The experiment compares the method with the specified baseline setting." },
  { kind: "limitation", claim: "作者未测量训练延迟。", quote: "The authors did not measure training latency under this experimental setting." },
];
function fixture(target: Claim, paragraph = target.quote): GroundedResearchReportInput {
  const runId = "offline-claim-condition-run", sourceId = "offline-condition-source", eventId = "offline-condition-read";
  const evidenceId = "34bcc5ba-01ea-42db-ade9-d384b0d657be", url = "https://example.com/condition-study-v1";
  const claims = baseline.map(item => ({ ...(item.kind === target.kind ? target : item), locator: "Observed scope", evidenceEventId: eventId }));
  const content = `# Observed scope\n\n${claims.map(item => item.kind === target.kind ? paragraph : item.quote).join("\n\n")}`;
  const contentHash = createHash("sha256").update(content).digest("hex");
  return { runId, report: { researchEvidence: { reportVersion: "grounded-report/v1", works: [{ sourceId, supportedClaims: claims }], gaps: [] } },
    coverage: [{ sourceId, label: "Offline condition fixture", urls: [url], status: "complete", evidenceId, contentHash,
      totalChars: content.length, coveredChars: content.length, eventIds: [eventId] }],
    events: [{ id: eventId, runId, type: "source_checked", metadata: { receiptAuthority: "runtime", toolName: "webReadPage", ok: true,
      provider: "direct_http", method: "direct_defuddle", cleaner: "defuddle-0.19.4/zhiyu-2", url, finalUrl: url, finalUrlVerified: true,
      evidenceId, contentHash, offset: 0, contentLength: content.length, totalChars: content.length, nextOffset: null, qualityScore: 80 } }],
    snapshots: [{ sourceId, evidenceId, contentHash, url, content }] };
}
function check(target: Claim, paragraph = target.quote) { return verifyAndBuildGroundedResearchReport(fixture(target, paragraph)); }

describe("real report regressions for local definitions and experimental scope", () => {
  it("rejects the actual generative acronym translated as generalist without rewriting the old claim", () => {
    const input = fixture(method, methodParagraph), before = JSON.stringify(input);
    const result = verifyAndBuildGroundedResearchReport(input);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("generative");
    expect(result.issues.join(" ")).toContain("通用");
    expect(JSON.stringify(input)).toBe(before);
    expect("structured" in result).toBe(false);
  });
  it("rejects the actual comparison omitting its explicit same-paragraph Reward Bench scope", () => {
    const input = fixture(experiment, experimentParagraph), before = JSON.stringify(input);
    const result = verifyAndBuildGroundedResearchReport(input);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("Reward Bench");
    expect(result.issues.join(" ")).toContain("连续");
    expect(JSON.stringify(input)).toBe(before);
    expect("structured" in result).toBe(false);
  });
  it("accepts the same method with the generative model paradigm preserved", () => {
    expect(check({ ...method, claim: "SPCT通过在线强化学习培养生成式奖励模型的奖励生成行为，使其自适应生成原则并准确生成批评。" }, methodParagraph).ok).toBe(true);
  });
  it("accepts a continuous quote containing the scope and a bounded comparison claim", () => {
    expect(check({ ...experiment, quote: `${benchmarkCondition} ${experiment.quote}`,
      claim: "在RewardBench测试中，DeepSeek-GRM-27B以32个样本直接投票可能达到与671B MoE模型相当的性能。" }, experimentParagraph).ok).toBe(true);
  });
});

describe("definition guard follows local evidence instead of an acronym answer table", () => {
  const quote = "The procedure trains GEMS models to generate accurate reward explanations.";
  const context = `We introduce generative reward modeling (GEMS) for this procedure. ${quote}`;
  const inspect = (claim: string, source = context, selected = quote) => researchClaimConditionIssues({ kind: "method", claim, quote: selected, context: source });
  it("rejects the same confusion for a previously unknown locally defined acronym", () => {
    expect(inspect("该过程训练通用奖励模型生成奖励解释。").join(" ")).toContain("generative");
  });
  it.each(["该过程训练生成式奖励模型生成奖励解释。", "该过程训练GEMS模型生成奖励解释。", "该过程以生成式奖励模型服务通用奖励任务。"]) ("keeps the explicit paradigm or the original acronym: %s", claim => {
    expect(inspect(claim)).toEqual([]);
  });
  it("does not use a generative word in another Chinese clause to redeem the mislabeled model", () => {
    expect(inspect("该过程训练通用奖励模型，其他模型采用生成式范式。").length).toBeGreaterThan(0);
  });
  it("accepts generalist reward generation as a breadth goal", () => {
    expect(inspect("该方法通过原则与批评增强通用奖励生成。", "", "The method reinforces generalist reward generation with adaptive principles and critiques.")).toEqual([]);
  });
  it("does not decide an acronym from a definition in a neighboring paragraph", () => {
    expect(inspect("该过程训练通用奖励模型生成奖励解释。", `We introduce generative reward modeling (GEMS).\n\n${quote}`)).toEqual([]);
  });
  it("does not infer the missing definition from the acronym or source name", () => {
    expect(inspect("该过程训练通用奖励模型生成奖励解释。", quote)).toEqual([]);
    expect(researchClaimConditionIssues({ ...method, context: method.quote })).toEqual([]);
  });
  it("does not turn a generalist definition or another scientific domain into generative reward modeling", () => {
    expect(inspect("该过程训练通用奖励模型生成奖励解释。", `We introduce generalist reward modeling (GEMS). ${quote}`)).toEqual([]);
    expect(inspect("该过程训练通用奖励模型生成奖励解释。", `We introduce generative image modeling (GEMS). ${quote}`)).toEqual([]);
  });
  it("uses the explicit complete generative phrase in the selected quote", () => {
    expect(inspect("该过程训练通用奖励模型生成奖励解释。", "", "The procedure trains generative reward models to generate accurate reward explanations.").length).toBeGreaterThan(0);
  });
  it("ignores supplied context which does not contain the selected quote", () => {
    expect(inspect("该过程训练通用奖励模型生成奖励解释。", "We introduce generative reward modeling (GEMS) for a different process.")).toEqual([]);
  });
  it("does not invert an explicit non-generative description into a generative definition", () => {
    expect(inspect("该过程训练通用奖励模型生成奖励解释。", `We introduce non-generative reward modeling (GEMS). ${quote}`)).toEqual([]);
    expect(inspect("该过程训练通用奖励模型生成奖励解释。", "", "These are not generative reward models in the reported procedure.")).toEqual([]);
  });
  it("does not relabel a distinct named model while checking a cross-topic synthesis", () => {
    expect(inspect("GEMS是生成式奖励模型，BetaRM是另一个研究中的通用奖励模型。")).toEqual([]);
  });
});

describe("explicit named test scope stays with the selected local model comparison", () => {
  const condition = "The models are evaluated on the Alpha Bench.";
  const quote = "AlphaRM outperforms the baseline models in the reported comparison.";
  const claim = "AlphaRM的表现优于基线模型。";
  const inspect = (targetClaim = claim, targetQuote = quote, context = `${condition} ${targetQuote}`, kind: Claim["kind"] = "experiment") =>
    researchClaimConditionIssues({ claim: targetClaim, quote: targetQuote, context, kind });
  it("requires the observed test condition in both the continuous quote and the claim", () => {
    const issues = inspect().join(" ");
    expect(issues).toContain("Alpha Bench");
    expect(issues).toContain("结论与选中短摘");
  });
  it("does not let a condition supplied only in the claim replace selected evidence", () => {
    const issues = inspect("在AlphaBench测试中，AlphaRM的表现优于基线模型。").join(" ");
    expect(issues).toContain("选中短摘未保留");
    expect(issues).not.toContain("结论未保留");
  });
  it("does not let a condition present only in the quote redeem an unscoped claim", () => {
    expect(inspect(claim, `${condition} ${quote}`).join(" ")).toContain("结论未保留");
  });
  it("normalizes benchmark case and whitespace while preserving complete identity", () => {
    expect(inspect("在alphaBench测试中，AlphaRM的表现优于基线模型。", `${condition} ${quote}`)).toEqual([]);
    expect(inspect("在AlphaBenchV2测试中，AlphaRM的表现优于基线模型。", `${condition} ${quote}`).join(" ")).toContain("结论未保留");
  });
  it("does not infer a benchmark when the source gives an unspecified qualitative comparison", () => {
    expect(inspect(claim, quote, quote)).toEqual([]);
  });
  it("does not borrow a benchmark from another paragraph", () => {
    expect(inspect(claim, quote, `${condition}\n\n${quote}`)).toEqual([]);
  });
  it("does not turn a remote same-paragraph condition into a closed set of all comparison conditions", () => {
    expect(inspect(claim, quote, `${condition} The authors discuss a separate mechanism. ${quote}`)).toEqual([]);
  });
  it("does not attach another named model's test to the selected comparison", () => {
    expect(inspect(claim, quote, `BetaRM models are tested on the Alpha Bench. ${quote}`)).toEqual([]);
  });
  it("does not scan for arbitrary benchmark-looking names without an explicit evaluation clause", () => {
    expect(inspect(claim, quote, `The article discusses Alpha Bench in background. ${quote}`)).toEqual([]);
  });
  it("leaves unnamed test settings outside the named identity guard", () => {
    expect(inspect(claim, quote, `The models are evaluated on the held-out test set. ${quote}`)).toEqual([]);
  });
  it.each(["The models are not evaluated on the Alpha Bench.", "The models might be evaluated on the Alpha Bench.", "If the models are evaluated on the Alpha Bench, they produce a comparison."])("does not invent an observed test setting from negation or speculation: %s", setting => {
    expect(inspect(claim, quote, `${setting} ${quote}`)).toEqual([]);
  });
  it("does not transfer test scope into method/limitation claims", () => {
    expect(inspect(claim, quote, `${condition} ${quote}`, "method")).toEqual([]);
    expect(inspect(claim, quote, `${condition} ${quote}`, "limitation")).toEqual([]);
  });
  it("keeps non-comparison and unknown unaligned paraphrases independently unverified", () => {
    expect(inspect("AlphaRM参与本实验的测试。")).toEqual([]);
    expect(inspect("另一个研究中的天气更好。")).toEqual([]);
    expect(inspect("模型输出具有解释性。", "The models produce explanations during the reported experiment.")).toEqual([]);
  });
  it("keeps an unrelated benchmark in a selected neighboring paragraph from substituting for this condition", () => {
    expect(inspect("在AlphaBench测试中，AlphaRM的表现优于基线模型。", `The models are evaluated on the Alpha Bench.\n\n${quote}`, `${condition} ${quote}`).join(" ")).toContain("选中短摘未保留");
  });
});
