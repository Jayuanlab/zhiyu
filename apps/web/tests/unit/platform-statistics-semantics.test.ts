import { describe, expect, it } from "vitest";
import { PLATFORM_STATISTICS_COLLECTION_RULES, needsPlatformPopulationStatistics, selectPlatformStatisticsSources, platformStatisticsCollectionMember, platformStatisticsSemantics } from "@/lib/ai/platform-statistics-semantics";

const full = { source: "interaction_processing_jobs.status", status: "ok", total: 7,
  groups: [{ value: "completed", count: 5 }, { value: "running", count: 2 }],
  fullOwnerGroupQuery: true, scope: "frozen_owner_capture" as const };

describe("source-bound aggregate meanings", () => {
  it("narrows explicit population subjects without widening the adapter's source catalog", () => {
    const sources = ["workshops.status", "loops.status", "brain_memories.status", "interaction_events.processed_status", "workshop_heartbeats.scheduler_status", "paper_orders.status"];
    expect(selectPlatformStatisticsSources("车间按配置状态各有多少个？", sources)).toEqual(["workshops.status"]);
    expect(selectPlatformStatisticsSources("原始交互消息按处理状态的数量？", sources)).toEqual(["interaction_events.processed_status"]);
    expect(selectPlatformStatisticsSources("车间心跳表记录有多少？", sources)).toEqual(["workshop_heartbeats.scheduler_status"]);
    expect(selectPlatformStatisticsSources("持续任务和记忆分别有多少？", sources)).toEqual(["loops.status", "brain_memories.status"]);
    expect(selectPlatformStatisticsSources("模拟委托按状态分布？", sources)).toEqual(["paper_orders.status"]);
    expect(selectPlatformStatisticsSources("记忆有多少？", ["loops.status"])).toEqual([]);
    expect(selectPlatformStatisticsSources("所有记录的数量分布？", sources)).toEqual(sources);
    expect(selectPlatformStatisticsSources(undefined, sources)).toEqual(sources);
  });
  it("keeps quantities in an exact record separate from owner-wide population counts", () => {
    const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
    expect(needsPlatformPopulationStatistics(`计划 ${id} 的数量和目标价是什么？`)).toBe(false);
    expect(needsPlatformPopulationStatistics(`Loop ${id} 下有多少条记录？`)).toBe(false);
    expect(needsPlatformPopulationStatistics("当前用户有多少条处理任务？各状态数量是什么？")).toBe(true);
    expect(needsPlatformPopulationStatistics(`核对 ${id} 并统计当前用户的全部记录数量`)).toBe(true);
    expect(needsPlatformPopulationStatistics("读取来源正文")).toBe(false);
  });
  it("keeps CamelCase table subjects and captured heartbeat counts discoverable", () => {
    const sources = ["workshops.status", "interaction_events.processed_status", "interaction_processing_jobs.status", "rag_documents.content_type", "workshop_heartbeats.count"];
    expect(selectPlatformStatisticsSources("workshopHeartbeats 数量", sources)).toEqual(["workshop_heartbeats.count"]);
    expect(selectPlatformStatisticsSources("车间心跳表有多少记录", sources)).toEqual(["workshop_heartbeats.count"]);
    expect(selectPlatformStatisticsSources("interactionEvents 与 interactionProcessingJobs 的数量", sources)).toEqual(["interaction_events.processed_status", "interaction_processing_jobs.status"]);
    expect(selectPlatformStatisticsSources("ragDocuments 数量", sources)).toEqual(["rag_documents.content_type"]);
  });
  it.each(["消息理解作业", "消息理解任务", "理解作业", "加工任务", "加工作业", "处理队列", "处理任务", "处理作业"])("narrows %s to the existing job dimension rather than the whole catalog", topic => {
    const sources = ["workshops.status", "brain_memories.status", "interactionEvents.processedStatus", "interactionProcessingJobs.status", "paper_orders.status"];
    expect(selectPlatformStatisticsSources(`当前用户的${topic}，等待、完成、失败等状态各有多少个？`, sources)).toEqual(["interactionProcessingJobs.status"]);
    expect(selectPlatformStatisticsSources(`${topic}数量`, ["interaction_events.processed_status"])).toEqual([]);
  });
  it("does not reinterpret raw WeChat observations as processing jobs", () => {
    const sources = ["brain_memories.status", "interaction_events.processed_status", "interaction_processing_jobs.status"];
    expect(selectPlatformStatisticsSources("原始微信消息的处理状态数量", sources)).toEqual(["interaction_events.processed_status"]);
    expect(selectPlatformStatisticsSources("原始微信消息与消息理解作业的状态数量", sources)).toEqual(["interaction_events.processed_status", "interaction_processing_jobs.status"]);
  });
  it("keeps an explicit whole-platform request broad when it names an example", () => {
    const sources = ["workshops.status", "loops.status", "brain_memories.status", "workshop_heartbeats.count"];
    expect(selectPlatformStatisticsSources("统计全部平台记录，包括车间；分别列出每类记录的数量和状态分布", sources)).toEqual(sources);
    expect(selectPlatformStatisticsSources("all platform records, including workshops: count each population", sources)).toEqual(sources);
    expect(selectPlatformStatisticsSources("全部车间按状态各有多少？", sources)).toEqual(["workshops.status"]);
  });
  it("retains each explicit population when table aliases and singular memory are mixed", () => {
    const sources = ["loops.status", "brain_memories.status", "user_llm_api_settings.enabled"];
    expect(selectPlatformStatisticsSources("Count userLlmApiSettings.enabled and loops.status for the current owner", sources)).toEqual(["loops.status", "user_llm_api_settings.enabled"]);
    expect(selectPlatformStatisticsSources("Count memory statuses and loop statuses for the current owner", sources)).toEqual(["loops.status", "brain_memories.status"]);
  });
  it("permits zero for absent groups only within a complete owner query", () => {
    expect(platformStatisticsSemantics(full).counting).toMatchObject({ coverage: "complete_owner_group_query",
      absentGroupMeaning: "zero_within_this_read_scope", unclassifiedCount: 0, classificationScope: "source_dimension_values_only" });
  });
  it("preserves a present NULL group as unclassified", () => {
    expect(platformStatisticsSemantics({ ...full, total: 8, groups: [...full.groups, { value: null, count: 1 }] }).counting.unclassifiedCount).toBe(1);
  });
  it("does not treat a bounded sample or an unavailable query as zero", () => {
    expect(platformStatisticsSemantics({ ...full, scope: "bounded_sample" }).counting.absentGroupMeaning).toBe("unknown");
    expect(platformStatisticsSemantics({ ...full, status: "unavailable", total: 0, groups: [] }).counting).toMatchObject({ coverage: "unavailable", absentGroupMeaning: "unknown" });
  });
  it("rejects partial, inconsistent and duplicated aggregate coverage", () => {
    for (const override of [{ total: 9 }, { groups: [{ value: "completed", count: 7 }, { value: "completed", count: 0 }] },
      { groups: [{ count: 7 }] }, { groups: [{ value: "completed", count: -1 }] }, { groups: [{ value: Number.NaN, count: 7 }] },
      { groups: [{ value: BigInt(1), count: 7 }] }, { total: "7" }, { fullOwnerGroupQuery: false }]) {
      expect(platformStatisticsSemantics({ ...full, ...override }).counting).toMatchObject({ coverage: "not_established", absentGroupMeaning: "unknown" });
    }
  });
  it("keeps queue state, command processing, order state and capture state separate from business proof", () => {
    for (const [source, blocked] of [["workshop_outbox.status", "provider_confirmed_delivery"], ["workCommands.status", "external_action_success"],
      ["paper_orders.status", "actual_fill"], ["work_run_evidence_bundles.captureStatus", "business_acceptance"]]) {
      expect(platformStatisticsSemantics({ ...full, source }).recordSemantics).toMatchObject({ verification: "not_assessed", doesNotEstablish: expect.arrayContaining([blocked]) });
    }
  });
  it("allows an actual successful empty GROUP BY result without inventing classifications", () => {
    expect(platformStatisticsSemantics({ ...full, scope: "live_owner_read", total: 0, groups: [] }).counting).toMatchObject({ coverage: "complete_owner_group_query", absentGroupMeaning: "zero_within_this_read_scope", unclassifiedCount: 0 });
  });
  it("shares repeated prose without removing source facts or applying full-query rules to failed members", () => {
    const original = platformStatisticsSemantics({ ...full, source: "workshop_outbox.status" });
    const member = platformStatisticsCollectionMember(original);
    expect(member.recordSemantics).toEqual(original.recordSemantics);
    const { instruction: _instruction, ...facts } = original.counting;
    expect(member.counting).toMatchObject(facts);
    expect(member.counting).toMatchObject({ instructionRef: "collection.semanticsRules.completeOwnerGroupQuery" });
    expect(PLATFORM_STATISTICS_COLLECTION_RULES.completeOwnerGroupQuery).toBe(original.counting.instruction);
    for (const override of [{ status: "unavailable" }, { scope: "bounded_sample" as const }, { fullOwnerGroupQuery: false }]) {
      const failed = platformStatisticsSemantics({ ...full, ...override });
      expect(platformStatisticsCollectionMember(failed)).toEqual(failed);
      expect(failed.counting.absentGroupMeaning).toBe("unknown");
    }
    const sharedCharacters = JSON.stringify({ semanticsRules: PLATFORM_STATISTICS_COLLECTION_RULES, results: Array(16).fill(member) }).length;
    expect(sharedCharacters).toBeLessThan(JSON.stringify({ results: Array(16).fill(original) }).length);
    expect(sharedCharacters).toBeLessThan(24000);
  });
});
