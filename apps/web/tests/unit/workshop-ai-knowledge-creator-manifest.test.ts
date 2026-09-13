import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWorkshopManifest } from "@/lib/workshops/manifest";

describe("AI knowledge creator manifest", () => {
  it("passes review and keeps public publishing behind owner approval", async () => {
    const manifestYaml = readFileSync(
      join(
        process.cwd(),
        "..",
        "..",
        "manifests",
        "workshops",
        "ai-knowledge-creator.workshop.yaml",
      ),
      "utf8",
    );

    const { review } = await reviewWorkshopManifest({
      userId: "00000000-0000-4000-8000-000000000001",
      manifestYaml,
      existingWorkshops: [],
    });

    expect(review.issues.filter((issue) => issue.severity === "error")).toEqual(
      [],
    );
    expect(review.requestedSkills).toContain("ai-knowledge-creator");
    expect(review.requestedTools).toEqual(
      expect.arrayContaining([
        "webReadPage",
        "videoRenderInvestmentBrief",
        "douyinCreatePublishDraft",
        "douyinPrepareUpload",
        "douyinPublishApprovedDraft",
      ]),
    );
    expect(manifestYaml).toContain("externalWrites: require_approval");
    expect(manifestYaml).toContain("aiGenerated: true");
    expect(manifestYaml).not.toMatch(/[锟�]/);
  });
});
