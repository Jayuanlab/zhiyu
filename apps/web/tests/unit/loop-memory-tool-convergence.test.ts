import { describe, expect, it } from "vitest";
import { LOOP_WORKSHOP_ALLOWED_TOOLS } from "@/lib/loops/native-executor";

describe("loop memory tool convergence", () => {
  it("keeps loop memory recall on the workshop Brain path by default", () => {
    expect(LOOP_WORKSHOP_ALLOWED_TOOLS).toContain("workshopSearchMemory");
    expect(LOOP_WORKSHOP_ALLOWED_TOOLS).toContain("workshopGetMemoryEvidence");
    expect(LOOP_WORKSHOP_ALLOWED_TOOLS).not.toContain("searchUnifiedMemory");
    expect(LOOP_WORKSHOP_ALLOWED_TOOLS).not.toContain("searchMemoryPath");
    expect(LOOP_WORKSHOP_ALLOWED_TOOLS).not.toContain("getRawMessages");
    expect(LOOP_WORKSHOP_ALLOWED_TOOLS).not.toContain("searchRawMessages");
  });
});
