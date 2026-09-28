import { describe, expect, it } from "vitest";
import {
  getBlockedNativeModelAttachmentNames,
  getModelConfig,
  MODELS,
} from "@/components/agent/model-selector";

describe("native Pi model selector entry", () => {
  it("exposes a text-only Pi model that maps to the Pi native provider", () => {
    expect(MODELS["pi/qwen-plus"]).toMatchObject({
      id: "pi/qwen-plus",
      name: "Pi Qwen Plus",
      provider: "Pi",
      description:
        "Pi runtime for text run/plan/execute with migrated read/control/reviewable tools, Insight and paused Loop task and Loop change proposals, RAG, text/PDF/Word attachment context, and text workspace files. No images, non-PDF binary files, MCP, sandbox, direct Insight apply, direct Loop update/delete, or direct WeChat send yet.",
      nativeAgentProvider: "pi",
      nativeModelId: "qwen-plus",
      textOnly: true,
      supportsVision: false,
    });
    expect(getModelConfig("pi/qwen-plus")).toBe(MODELS["pi/qwen-plus"]);
  });

  it("makes the current Pi capability boundary visible to desktop Web users", () => {
    const description = MODELS["pi/qwen-plus"].description;

    expect(description).toContain("text run/plan/execute");
    expect(description).toContain("read/control/reviewable tools");
    expect(description).toContain("Insight");
    expect(description).toContain("paused Loop task and Loop change proposals");
    expect(description).toContain("text workspace files");
    expect(description).toContain("No images");
    expect(description).toContain("text/PDF/Word attachment context");
    expect(description).toContain("MCP");
    expect(description).toContain("sandbox");
    expect(description).toContain("direct Insight apply");
    expect(description).toContain("direct Loop update/delete");
    expect(description).toContain("direct WeChat send");
  });

  it("blocks image attachments before submitting to the Pi text-only provider", () => {
    expect(
      getBlockedNativeModelAttachmentNames("pi/qwen-plus", [
        { name: "chart.png", contentType: "image/png" },
        { name: "notes.txt", contentType: "text/plain" },
      ]),
    ).toEqual(["chart.png"]);

    expect(
      getBlockedNativeModelAttachmentNames("anthropic/claude-sonnet-4.6", [
        { name: "chart.png", contentType: "image/png" },
      ]),
    ).toEqual([]);
  });

});
