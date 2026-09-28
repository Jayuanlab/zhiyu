import {
  normalizeAgentRuntimeEngine,
  normalizePiModelProtocol,
  resolveLoopAgentRuntime,
  resolvePiAgentModelConfig,
  resolveWorkshopAgentRuntime,
} from "@/lib/ai/model-policy";
import { afterEach, describe, expect, it } from "vitest";

const originalWorkshopRuntime = process.env.WORKSHOP_AGENT_RUNTIME;
const originalLoopRuntime = process.env.LOOP_AGENT_RUNTIME;
const originalWorkshopProtocol = process.env.WORKSHOP_PI_MODEL_PROTOCOL;
const originalLoopProtocol = process.env.LOOP_PI_MODEL_PROTOCOL;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv("WORKSHOP_AGENT_RUNTIME", originalWorkshopRuntime);
  restoreEnv("LOOP_AGENT_RUNTIME", originalLoopRuntime);
  restoreEnv("WORKSHOP_PI_MODEL_PROTOCOL", originalWorkshopProtocol);
  restoreEnv("LOOP_PI_MODEL_PROTOCOL", originalLoopProtocol);
});

describe("agent runtime selection", () => {
  it("defaults workshops and their loops to Pi", () => {
    expect(
      resolveWorkshopAgentRuntime({ workshop: { modelConfig: {} } as any }),
    ).toEqual({ engine: "pi", source: "default" });
    expect(resolveLoopAgentRuntime({loop:{contextConfig:{}} as any,workshop:{modelConfig:{}} as any}).engine).toBe("pi");
  });

  it("selects Pi for workshops when modelConfig requests it", () => {
    expect(
      resolveWorkshopAgentRuntime({
        workshop: {
          modelConfig: {
            agentRuntimeEngine: "pi",
            piModelProtocol: "openai-responses",
          },
        } as any,
      }),
    ).toEqual({
      engine: "pi",
      source: "config",
      piProtocol: "openai-responses",
    });
  });

  it("lets loop context config override workshop runtime config", () => {
    expect(
      resolveLoopAgentRuntime({
        loop: {
          contextConfig: {
            runtimeEngine: "claude",
            piProtocol: "openai-responses",
          },
        } as any,
        workshop: {
          modelConfig: {
            agentRuntimeEngine: "pi",
            piModelProtocol: "anthropic-messages",
          },
        } as any,
      }),
    ).toEqual({
      engine: "claude",
      source: "config",
      piProtocol: "openai-responses",
    });
  });

  it("falls back to env selection when config is empty", () => {
    process.env.WORKSHOP_AGENT_RUNTIME = "pi";
    process.env.WORKSHOP_PI_MODEL_PROTOCOL = "anthropic-messages";

    expect(
      resolveWorkshopAgentRuntime({ workshop: { modelConfig: {} } as any }),
    ).toEqual({
      engine: "pi",
      source: "env",
      piProtocol: "anthropic-messages",
    });
  });

  it("accepts OpenAI Chat Completions as a Pi runtime protocol", () => {
    process.env.LOOP_AGENT_RUNTIME = "pi";
    process.env.LOOP_PI_MODEL_PROTOCOL = "openai-completions";

    expect(
      resolveWorkshopAgentRuntime({
        workshop: {
          modelConfig: {
            agentRuntimeEngine: "pi",
            piModelProtocol: "openai-completions",
          },
        } as any,
      }),
    ).toEqual({
      engine: "pi",
      source: "config",
      piProtocol: "openai-completions",
    });

    expect(
      resolveLoopAgentRuntime({
        loop: { contextConfig: {} } as any,
        workshop: null,
      }),
    ).toEqual({
      engine: "pi",
      source: "env",
      piProtocol: "openai-completions",
    });
  });



  it("resolves Pi model config from user OpenAI-compatible settings first", () => {
    expect(
      resolvePiAgentModelConfig({
        userConfig: {
          apiKey: "user-key",
          baseUrl: "https://user.example.com/v1",
          model: "user-pi-model",
          providerType: "openai_compatible",
        } as any,
        envConfig: {
          apiKey: "env-key",
          baseUrl: "https://env.example.com/v1",
          model: "env-pi-model",
          piProtocol: "anthropic-messages",
          providerId: "env-provider",
        },
        runtimeProtocol: "openai-responses",
        fallbackModel: "claude-fallback-model",
      }),
    ).toEqual({
      provider: "pi",
      source: "user",
      apiKey: "user-key",
      baseUrl: "https://user.example.com/v1",
      model: "user-pi-model",
      piProtocol: "openai-responses",
      providerId: "env-provider",
    });
  });

  it("resolves Pi model config from LLM env before the Claude fallback model", () => {
    expect(
      resolvePiAgentModelConfig({
        userConfig: null,
        envConfig: {
          apiKey: "env-key",
          baseUrl: "https://env.example.com/v1",
          model: "env-pi-model",
          piProtocol: "anthropic-messages",
        },
        fallbackModel: "claude-fallback-model",
      }),
    ).toMatchObject({
      provider: "pi",
      source: "env",
      apiKey: "env-key",
      baseUrl: "https://env.example.com/v1",
      model: "env-pi-model",
      piProtocol: "anthropic-messages",
    });
  });

  it("keeps Pi default explicit when neither user nor LLM env model exists", () => {
    expect(
      resolvePiAgentModelConfig({
        userConfig: null,
        envConfig: {},
        fallbackModel: "claude-fallback-model",
      }),
    ).toMatchObject({
      provider: "pi",
      source: "default",
      model: "claude-fallback-model",
    });
  });

  it("normalizes only supported runtime engines and Pi protocols", () => {
    expect(normalizeAgentRuntimeEngine("pi")).toBe("pi");
    expect(normalizeAgentRuntimeEngine("claude")).toBe("claude");
    expect(normalizeAgentRuntimeEngine("other")).toBeNull();
    expect(normalizePiModelProtocol("anthropic-messages")).toBe(
      "anthropic-messages",
    );
    expect(normalizePiModelProtocol("openai-responses")).toBe(
      "openai-responses",
    );
    expect(normalizePiModelProtocol("openai-completions")).toBe(
      "openai-completions",
    );
    expect(normalizePiModelProtocol("other")).toBeNull();
  });
});
