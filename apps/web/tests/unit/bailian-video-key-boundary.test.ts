import { afterEach, describe, expect, it, vi } from "vitest";
import { generateBailianInvestmentVideo } from "@/lib/video/bailian-video-client";

const bailianKeyNames = [
  "AI_VIDEO_AGENT_VIDEO_API_KEY",
  "AI_VIDEO_AGENT_WAN_API_KEY",
  "BAILIAN_VIDEO_API_KEY",
  "DASHSCOPE_API_KEY",
  "BAILIAN_API_KEY",
];

describe("Bailian video credential boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not send a planner or interaction key to Bailian", async () => {
    for (const name of bailianKeyNames) vi.stubEnv(name, "");
    vi.stubEnv("AI_VIDEO_AGENT_LLM_API_KEY", "other-provider-key");
    vi.stubEnv("WORKSHOP_PLANNER_LLM_API_KEY", "other-provider-key");
    vi.stubEnv("INTERACTION_PROCESSOR_LLM_API_KEY", "other-provider-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateBailianInvestmentVideo({
      prompt: "test prompt",
      poll: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing Bailian video API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a dedicated Bailian video key when present", async () => {
    for (const name of bailianKeyNames) vi.stubEnv(name, "");
    vi.stubEnv("BAILIAN_VIDEO_API_KEY", "bailian-test-key");
    vi.stubEnv("INTERACTION_PROCESSOR_LLM_API_KEY", "other-provider-key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ output: { task_id: "task-123" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateBailianInvestmentVideo({
      prompt: "test prompt",
      poll: false,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.headers.authorization).toBe(
      "Bearer bailian-test-key",
    );
  });
});
