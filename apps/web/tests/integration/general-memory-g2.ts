import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { closeDb } from "@/lib/db/adapters";
import { user, brainMemories } from "@/lib/db/schema";
import {
  brainMemoryToInsertRow,
  brainMemoryFromRow,
} from "@/lib/memory/records/memory-record";
import { getBrainMemoryById } from "@/lib/memory/adapters/postgres/memory-records";
import { proposeLessonExtraction } from "@/lib/memory/governance/lesson-extraction";
import {
  governRecordLifecycle,
  listLifecycleRecords,
} from "@/lib/memory/governance/record-lifecycle";
import { reviewMemory, writeMemory } from "@/lib/memory/revision/writes";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { recordLifecycleView } from "@/lib/memory/records/lifecycle";
import { buildBrainContextPack } from "@/lib/memory/context/pack";
import { extractedLessonOmitReason } from "@/lib/memory/records/lesson-extraction";
import { admitExactUse } from "@/lib/memory/context/exact-use-admission";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";

async function main() {
  assert.equal(process.env.ZHIYU_TEST_MODE, "integration");
  assert.match(
    new URL(process.env.POSTGRES_URL!).pathname,
    /^\/zhiyu_test_[a-f0-9]{32}$/,
  );
  assert.equal(process.env.POSTGRES_URL, process.env.ZHIYU_TEST_DATABASE_URL);
  const owner = randomUUID(),
    stranger = randomUUID(),
    workId = randomUUID(),
    requester = {
      type: "chat" as const,
      userId: owner,
      id: "memory-lifecycle-owner",
    },
    checks: string[] = [];
  try {
    await db.insert(user).values([
      { id: owner, email: "operational@example.invalid" },
      { id: stranger, email: "other@example.invalid" },
    ]);
    const raw: BrainMemory = {
      id: randomUUID(),
      userId: owner,
      scope: { type: "work", workId },
      ownerType: "work",
      ownerId: workId,
      memoryType: "plan",
      subject: "Mixed operational report",
      content:
        "2026-10-01盘后复盘：持仓未变。\n【教训】执行信号不能替代当前工具许可，应分别核验。\n【账户】模拟数据",
      status: "active",
      confidence: 80,
      evidenceRefs: ["fixture-source"],
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    };
    await db.insert(brainMemories).values(brainMemoryToInsertRow(raw));
    const source = (await getBrainMemoryById({
      userId: owner,
      memoryId: raw.id,
    }))!;
    assert.equal(recordLifecycleView(source).phase, "archived");
    assert.equal(source.content, raw.content);
    assert.equal(
      (source.metadata?.recordLifecycle as any).policy.id,
      "zhiyu.memory.records",
    );
    assert.equal(
      (source.metadata?.recordLifecycle as any).policy.version,
      "2.0.0",
    );
    checks.push("new_mixed_report_classified_without_rewrite");
    const quote = "【教训】执行信号不能替代当前工具许可，应分别核验。",
      command = {
        requester,
        sourceMemoryId: raw.id,
        expectedVersion: getBrainMemoryRevisionVersion(source),
        commandId: randomUUID(),
        offset: raw.content.indexOf(quote),
        quote,
        conclusion: "状态评估和动作许可应分别核对。",
        conditions: "仅在本模拟任务使用，先查询当前工具约束。",
        counterexample: "历史成功不能证明本轮拥有执行权限。",
        recheckWhen: "角色、工具权限或数据源变化时复查。",
        validityDays: 30,
      };
    await assert.rejects(
      proposeLessonExtraction({
        ...command,
        requester: { ...requester, userId: stranger },
      }),
    );
    await assert.rejects(
      proposeLessonExtraction({
        ...command,
        requester: { ...requester, type: "work" },
      }),
    );
    checks.push("owner_and_cross_owner_boundary");
    await assert.rejects(
      proposeLessonExtraction({ ...command, offset: 0 }),
      /Quote/,
    );
    await assert.rejects(
      proposeLessonExtraction({
        ...command,
        conclusion: "现价=20，当前持仓不变",
      }),
      /independent/,
    );
    checks.push("exact_span_and_snapshot_intake_rejection");
    await assert.rejects(
      writeMemory({
        requester,
        scope: raw.scope,
        ownerType: "work",
        ownerId: workId,
        memoryType: "insight",
        subject: "forgery",
        content: "no",
        metadata: { lessonExtraction: { sourceMemoryId: raw.id } },
      }),
      /Protected/,
    );
    checks.push("ordinary_writer_cannot_forge_source_binding");
    const first = await proposeLessonExtraction(command),
      replay = await proposeLessonExtraction(command),
      duplicate = await proposeLessonExtraction({
        ...command,
        commandId: randomUUID(),
      });
    assert.equal(replay.replayed, true);
    assert.equal(duplicate.candidateId, first.candidateId);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await db.select().from(brainMemories)).length, 2);
    checks.push("command_and_semantic_deduplication");
    const read = async () =>
      (await getBrainMemoryById({
        userId: owner,
        memoryId: first.candidateId,
      }))!;
    let lesson = await read();
    assert.equal(lesson.status, "candidate");
    assert.deepEqual(lesson.scope, source.scope);
    assert.equal(extractedLessonOmitReason(lesson), null);
    const pack = (memory: BrainMemory) =>
      buildBrainContextPack({
        memories: [memory],
        requester,
        accessMode: "owner_override",
        applicabilityMode: "discovery",
        includeCandidates: true,
        taskIntent: "permission",
        now: new Date(),
      });
    assert.equal(pack(lesson).items.length, 0);
    checks.push("candidate_not_usable_before_owner_review");
    await assert.rejects(
      reviewMemory({
        requester,
        memoryId: lesson.id,
        decision: "confirmed",
        expectedVersion: getBrainMemoryRevisionVersion(lesson),
      }),
    );
    await reviewMemory({
      requester,
      memoryId: lesson.id,
      decision: "confirmed",
      expectedVersion: getBrainMemoryRevisionVersion(lesson),
      evidenceConfirmed: true,
      reason:
        "Checked exact source, conditions and counterexample in isolated fixture",
    });
    lesson = await read();
    assert.equal(lesson.status, "verified");
    assert.equal(pack(lesson).items.length, 1);
    await admitExactUse({
      requester,
      accessMode: "owner_override",
      purpose: "isolated_operational_test",
      memories: [lesson],
    });
    checks.push("reviewed_scoped_lesson_pack_and_exact_use");
    const change = await governRecordLifecycle({
      requester,
      memoryId: source.id,
      expectedVersion: command.expectedVersion,
      commandId: randomUUID(),
      action: "classify",
      recordClass: "run_record",
      reason: "Simulate source version change",
    });
    lesson = await read();
    assert.ok(extractedLessonOmitReason(lesson));
    assert.equal(pack(lesson).items.length, 0);
    await assert.rejects(
      admitExactUse({
        requester,
        accessMode: "owner_override",
        purpose: "isolated_stale_test",
        memories: [lesson],
      }),
    );
    await assert.rejects(
      reviewMemory({
        requester,
        memoryId: lesson.id,
        decision: "confirmed",
        expectedVersion: getBrainMemoryRevisionVersion(lesson),
        evidenceConfirmed: true,
        reason: "Must not reactivate stale source",
      }),
    );
    checks.push("source_invalidation_blocks_review_recall_and_egress");
    await governRecordLifecycle({
      requester,
      memoryId: source.id,
      expectedVersion: change.afterVersion,
      commandId: randomUUID(),
      action: "rollback",
      restoreReceiptId: change.receiptId,
      reason: "Restore unchanged exact source",
    });
    assert.equal(pack(await read()).items.length, 1);
    checks.push("source_rollback_restores_exact_binding");
    await assert.rejects(
      governRecordLifecycle({
        requester,
        memoryId: source.id,
        expectedVersion: command.expectedVersion,
        commandId: randomUUID(),
        action: "classify",
        recordClass: "long_term",
        reason: "Whole reports must not be promoted",
      }),
      /separate/,
    );
    checks.push("whole_report_promotion_rejected");
    await db
      .update(brainMemories)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(brainMemories.id, first.candidateId));
    lesson = await read();
    assert.equal(pack(lesson).items.length, 0);
    assert.equal(recordLifecycleView(lesson).phase, "review_expired");
    await assert.rejects(
      reviewMemory({
        requester,
        memoryId: lesson.id,
        decision: "confirmed",
        expectedVersion: getBrainMemoryRevisionVersion(lesson),
        evidenceConfirmed: true,
        reason: "Expired lesson cannot be extended by status review",
      }),
    );
    const expiredDuplicate = await proposeLessonExtraction({
      ...command,
      commandId: randomUUID(),
    });
    assert.equal(expiredDuplicate.candidateId, first.candidateId);
    assert.ok(Date.parse((await read()).expiresAt!) < Date.now());
    checks.push("expiry_requires_new_evidence_not_duplicate_renewal");
    const oldKnowledge = {
      ...raw,
      id: randomUUID(),
      memoryType: "insight" as const,
      content: "A reusable research explanation requires source review.",
      tags: [],
    };
    await db.insert(brainMemories).values(brainMemoryToInsertRow(oldKnowledge));
    const old = (await getBrainMemoryById({
      userId: owner,
      memoryId: oldKnowledge.id,
    }))!;
    const intake = await governRecordLifecycle({
      requester,
      memoryId: old.id,
      expectedVersion: getBrainMemoryRevisionVersion(old),
      commandId: randomUUID(),
      action: "classify",
      recordClass: "long_term",
      requireReview: true,
      reason: "Historical unreviewed knowledge intake",
    });
    assert.equal(
      (await getBrainMemoryById({ userId: owner, memoryId: old.id }))!.status,
      "candidate",
    );
    await governRecordLifecycle({
      requester,
      memoryId: old.id,
      expectedVersion: intake.afterVersion,
      commandId: randomUUID(),
      action: "rollback",
      restoreReceiptId: intake.receiptId,
      reason: "Restore exact original intake fixture",
    });
    assert.equal(
      getBrainMemoryRevisionVersion(
        (await getBrainMemoryById({ userId: owner, memoryId: old.id }))!,
      ),
      getBrainMemoryRevisionVersion(old),
    );
    checks.push("legacy_intake_review_and_exact_rollback");
    await db
      .insert(brainMemories)
      .values(
        Array.from({ length: 205 }, (_, i) =>
          brainMemoryToInsertRow({
            ...raw,
            id: randomUUID(),
            subject: `Page ${i}`,
          }),
        ),
      );
    const a = await listLifecycleRecords(owner, "run_record"),
      cursor = JSON.parse(
        Buffer.from(a.nextCursor!, "base64url").toString("utf8"),
      ),
      b = await listLifecycleRecords(owner, "run_record", 100, cursor);
    assert.equal(a.records.length, 100);
    assert.equal(b.records.length, 100);
    assert.ok(
      a.records.every((row) => !b.records.some((other) => other.id === row.id)),
    );
    checks.push("keyset_pagination_has_no_overlap");
    fs.writeFileSync(
      process.env.ZHIYU_LIFECYCLE_TEST_RESULT!,
      JSON.stringify({ passed: true, checks, count: checks.length }, null, 2),
    );
    console.log(JSON.stringify({ passed: true, checks: checks.length }));
  } finally {
    await closeDb();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
