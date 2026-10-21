import { expect, it } from "vitest";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";
import { analyzeOperationalContent, findLessonSpans, isVolatileLesson } from "@/lib/memory/records/operational-content";
import { classifyNewRecord, recordLifecycleView, memoryRecallOmitReason } from "@/lib/memory/records/lifecycle";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { verifyLessonSource, extractedLessonOmitReason } from "@/lib/memory/records/lesson-extraction";
import { buildBrainContextPack } from "@/lib/memory/context/pack";
const id = (n: number) => `11111111-1111-4111-a111-${String(n).padStart(12,"0")}`;
function record(patch: Partial<BrainMemory> = {}): BrainMemory { return { id:id(1),userId:id(2),scope:{type:"work",workId:id(3)},ownerType:"work",ownerId:id(3),memoryType:"insight",subject:"Report",content:"2026-10-20盘后复盘：收盘1.20，持仓100股。",status:"active",confidence:80,evidenceRefs:["source"],createdAt:"2026-10-20T00:00:00Z",updatedAt:"2026-10-20T00:00:00Z",...patch }; }
it("classifies snapshots, plan-shaped reports and mixed content without overwriting raw data",()=>{
 for(const type of ["fact","insight","plan"] as const){const raw=record({memoryType:type}),saved=classifyNewRecord(raw);expect(analyzeOperationalContent(raw)?.category).toBe("market_snapshot");expect(saved.content).toBe(raw.content);expect(recordLifecycleView(saved,new Date("2026-10-21T00:00:00Z"))).toMatchObject({phase:"archived",usableUntil:"2026-10-21T00:00:00.000Z",recallEligible:false});}
 const mixed=record({content:"2026-10-20盘后复盘：持仓不变。\n【教训】执行信号不能替代工具许可；需重新核验当前边界。\n【账户】原始数据"});
 expect(analyzeOperationalContent(mixed)?.category).toBe("mixed_content"); const spans=findLessonSpans(mixed.content);expect(spans).toHaveLength(1);expect(mixed.content.slice(spans[0].offset,spans[0].offset+spans[0].quote.length)).toBe(spans[0].quote);expect(spans[0].quote).not.toContain("【账户】");
});
it("keeps protected boundaries and pure reusable knowledge out of operational heuristics",()=>{
 expect(analyzeOperationalContent(record({memoryType:"boundary"}))).toBeNull();expect(analyzeOperationalContent(record({content:"GRPO uses group-relative reward advantages without a critic."}))).toBeNull();expect(analyzeOperationalContent(record({ownerType:"chat"}))?.category).toBe("market_snapshot");
 expect(analyzeOperationalContent(record({content:'{"kind":"timing_assessment","date":"2026-10-20","symbol":"515980"}'}))?.category).toBe("market_snapshot");
});
it("recognizes recurring self-audits and environment state",()=>{
 expect(analyzeOperationalContent(record({content:"Work 模型第九次自检（2026-10-20）：提案待审",tags:["work-self-audit"]}))?.category).toBe("daily_report");
 expect(analyzeOperationalContent(record({content:"edge_tts 模块未安装",tags:["dependency"]}))?.category).toBe("daily_report");expect(isVolatileLesson("现价=20，当前持仓不变")).toBe(true);
});
it("requires a host-verified exact source and owner review even when includeCandidates is true",()=>{
 const source=classifyNewRecord(record()),quote=source.content.slice(0,15),candidate=record({id:id(4),content:"Signals do not grant tool permissions.",status:"candidate",metadata:{lessonExtraction:{schemaVersion:"memory-lesson-extraction.v1",sourceMemoryId:source.id,sourceVersion:getBrainMemoryRevisionVersion(source),offset:0,quote,conditions:"scoped simulation",counterexample:"not a trading rule",recheckWhen:"policy changes"},recordLifecycle:{schemaVersion:"memory-record-lifecycle.v1",recordClass:"long_term",reason:"extracted",authority:"source_classification",classifiedAt:source.createdAt,usableUntil:null,retention:"preserve_audit"}}});
 expect(extractedLessonOmitReason(candidate)).toBe("lesson_source_changed_or_unverified");verifyLessonSource(candidate,source);expect(extractedLessonOmitReason(candidate)).toBeNull();expect(memoryRecallOmitReason(candidate)).toBe("lesson_requires_owner_review");
 const pack=buildBrainContextPack({memories:[candidate],requester:{type:"chat",userId:source.userId},accessMode:"owner_override",includeCandidates:true,taskIntent:"permissions"});expect(pack.items).toHaveLength(0);
 candidate.status="verified";expect(extractedLessonOmitReason(candidate)).not.toBeNull();verifyLessonSource(candidate,source);expect(memoryRecallOmitReason(candidate)).toBeNull();expect(extractedLessonOmitReason({...candidate})).toBeNull();
 expect(extractedLessonOmitReason(JSON.parse(JSON.stringify(candidate)))).not.toBeNull();
 source.content+=" changed";const copy=JSON.parse(JSON.stringify(candidate));verifyLessonSource(copy,source);expect(extractedLessonOmitReason(copy)).not.toBeNull();
});
