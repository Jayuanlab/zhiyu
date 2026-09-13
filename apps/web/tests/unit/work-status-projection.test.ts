import { describe, expect, it } from "vitest";
import { classifyOutbox, countWorkStatus, workStatusFromCounts } from "@/lib/workshops/status-projection";

describe("work status projection", () => {
  it('keeps unresolved sends visible without classifying them as new approvals',()=>{
    const counts=countWorkStatus([],[{status:'sending',source:null,count:2},{status:'unknown',source:'loop_suggested_action',count:1}]);
    expect(counts).toMatchObject({pendingOutbox:3,outboxSending:2,outboxUnknown:1,pendingApprovals:0,outboxDrafts:0});
    expect(workStatusFromCounts('active',counts)).toBe('blocked');
  });
  it("counts all status facts independently of display limits", () => {
    const facts = Array.from({length: 250}, () => ({status: "active", stateJson: {}, currentPhase: "idle", run: null}));
    const counts = countWorkStatus(facts, [{status: "draft", source: null, count: 600}]);
    expect(counts).toMatchObject({loops: 250, activeLoops: 250, pendingOutbox: 600, outboxDrafts: 600, pendingApprovals: 0});
    expect(workStatusFromCounts("active", counts)).toBe("active");
  });

  it("separates paused, activation proposals, approval, blocked and error", () => {
    const counts = countWorkStatus([
      {status: "paused", stateJson: {}, currentPhase: "idle", run: null},
      {status: "paused", stateJson: {requiresOwnerActivation: true}, currentPhase: "approval", run: null},
      {status: "active", stateJson: {}, currentPhase: "blocked", run: null},
      {status: "active", stateJson: {}, currentPhase: "error", run: null},
    ], [
      {status: "pending_approval", source: "loop_suggested_action", count: 2},
      {status: "draft", source: "loop_suggested_action", count: 9},
      {status: "approved", source: null, count: 1},
      {status: "blocked", source: null, count: 1},
    ]);
    expect(counts).toMatchObject({loops: 4, pendingLoopProposals: 1, pendingApprovals: 3, blockedLoops: 1, errorLoops: 1, pendingOutbox: 4, outboxReady: 1, outboxBlocked: 1, outboxDrafts: 0, attentionCount: 7});
  });

  it("keeps explicit blockers and approvals visible even for suggested actions", () => {
    expect(classifyOutbox({status: "blocked", boundaryResult: {source: "loop_suggested_action"}})).toBe("blocked");
    expect(classifyOutbox({status: "sent"})).toBeNull();
  });
});
