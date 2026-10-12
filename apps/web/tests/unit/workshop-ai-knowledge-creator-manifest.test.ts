import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWorkshopManifest } from "@/lib/workshops/manifest";
import YAML from "yaml";
import { resolveWorkshopSdkAllowedTools } from "@/lib/workshops/tool-access";

describe("AI knowledge creator manifest", () => {
  it("passes review and denies video and publishing tools in content-only mode", async () => {
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
        "webSearch",
        "workshopReadMemory",
        "workshopLogEvent",
      ]),
    );
    expect(manifestYaml).toContain("externalWrites: require_approval");
    const manifest = YAML.parse(manifestYaml);
    const suspended = ["videoRenderInvestmentBrief", "videoGenerateInvestmentBrief", "douyinCreatePublishDraft", "douyinPrepareUpload", "douyinPublishApprovedDraft"];
    expect(resolveWorkshopSdkAllowedTools({ modelConfig: manifest.spec.modelConfig }, ["webReadPage", "webSearch", ...suspended])).toEqual(["webReadPage", "webSearch"]);
    for (const loop of manifest.spec.loops) {
      expect(loop.actionPolicy.denied).toEqual(expect.arrayContaining(suspended));
      expect(loop.actionPolicy.allowed.some((name: string) => suspended.includes(name))).toBe(false);
      expect(loop.verification.requiredFields).toEqual(expect.arrayContaining(["discoveryCoverage", "contentMarkdown", "readerReview", "revisionSummary"]));
      expect(loop.actionPolicy.allowed).toContain("webSearch");
      expect(loop.context.sources.map((source: {name: string}) => source.name)).toEqual(expect.arrayContaining(["GitHub Trending", "Hugging Face Papers", "Mistral News"]));
      expect(loop.verification.requiredFields).not.toContain("localVideo");
    }
    expect(manifestYaml).not.toMatch(/[锟�]/);
  });
});
