import { describe, expect, it } from "vitest";
import { reviewWorkshopManifest } from "@/lib/workshops/manifest";

const baseManifest = (modelConfig: string) => `apiVersion: openzhiyu.ai/v1alpha1
kind: Workshop
metadata:
  name: runtime-review-fixture
  title: Runtime Review Fixture
spec:
  mission: Verify runtime selector review.
  role: general
  autonomyLevel: draft
  control:
    object: runtime_selector
    objective: keep runtime switching explicit and reviewable
  boundaryPolicy:
    mode: draft
    externalMessages: draft
    deniedPrecedence: true
  modelConfig:
${modelConfig
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
  loops:
    - name: runtime-review-loop
      title: Runtime Review Loop
      goal: Verify the runtime selector stays observable.
      skill: openzhiyu-memory
      status: paused
      trigger:
        type: manual
      context:
        sources: []
        instructions: Review runtime selector configuration only.
      actionPolicy:
        allowed:
          - workshopLogEvent
        denied:
          - externalPayment
      verification:
        requiredFields:
          - summary
        requiredSources:
          - manifest
        successCriteria:
          - Runtime selector fields are valid.
  sources: []
`;

describe("workshop runtime manifest review", () => {
  it("accepts explicit Pi runtime fields and warns when credentials are external", async () => {
    const { review } = await reviewWorkshopManifest({
      userId: "00000000-0000-4000-8000-000000000001",
      manifestYaml: baseManifest(`role: general
agentRuntimeEngine: pi
piModelProtocol: openai-responses`),
      existingWorkshops: [],
    });

    expect(review.issues.filter((issue) => issue.severity === "error")).toEqual(
      [],
    );
    expect(review.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          path: "spec.modelConfig.agentRuntimeEngine",
        }),
      ]),
    );
  });

  it("accepts OpenAI Chat Completions protocol for OpenCode Go compatible Pi runtime", async () => {
    const { review } = await reviewWorkshopManifest({
      userId: "00000000-0000-4000-8000-000000000001",
      manifestYaml: baseManifest(`role: general
agentRuntimeEngine: pi
piModelProtocol: openai-completions`),
      existingWorkshops: [],
    });

    expect(review.issues.filter((issue) => issue.severity === "error")).toEqual(
      [],
    );
  });


  it("warns when explicit Pi runtime is not a low-risk grey candidate", async () => {
    const { review } = await reviewWorkshopManifest({
      userId: "00000000-0000-4000-8000-000000000001",
      manifestYaml: baseManifest(`role: general
agentRuntimeEngine: pi
allowedTools:
  - workshopLogEvent
  - quantPaperPlaceOrder`),
      existingWorkshops: [],
    });

    expect(review.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          path: "spec.modelConfig.agentRuntimeEngine",
          message: expect.stringContaining("blocked"),
        }),
      ]),
    );
  });

  it("warns when explicit Pi runtime includes policy-scoped migrated tools", async () => {
    const { review } = await reviewWorkshopManifest({
      userId: "00000000-0000-4000-8000-000000000001",
      manifestYaml: baseManifest(`role: general
agentRuntimeEngine: pi
allowedTools:
  - workshopLogEvent
  - quantPaperProposeWatchlistChange`),
      existingWorkshops: [],
    });

    expect(review.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          path: "spec.modelConfig.agentRuntimeEngine",
          message: expect.stringContaining("policy-scoped"),
        }),
      ]),
    );
  });

  it("rejects unknown runtime engines and Pi protocols", async () => {
    const { review } = await reviewWorkshopManifest({
      userId: "00000000-0000-4000-8000-000000000001",
      manifestYaml: baseManifest(`role: general
agentRuntimeEngine: langchain
piModelProtocol: unknown-protocol`),
      existingWorkshops: [],
    });

    expect(review.ok).toBe(false);
    expect(review.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          path: "spec.modelConfig.agentRuntimeEngine",
        }),
        expect.objectContaining({
          severity: "error",
          path: "spec.modelConfig.piModelProtocol",
        }),
      ]),
    );
  });
});
