import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/native/providers/route";
import {
  normalizeNativeAgentProvider,
  resolveDefaultNativeAgentProvider,
} from "@/lib/ai/native-agent-default-provider";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("native agent providers API", () => {
  it("exposes Pi as a gated native agent provider", async () => {
    const response = await GET();
    const payload = await response.json();

    const pi = payload.agents.find((agent: { type: string }) => agent.type === "pi");

    expect(payload.defaultAgent).toBe("pi");
    expect(payload.defaultAgentSource).toBe("default");
    expect(pi).toMatchObject({
      type: "pi",
      supportsPlan: true,
      supportsStreaming: true,
      supportsSandbox: false,
      capabilities: {
        readOnlyContext: {
          textAttachments: true,
          workspaceTextFiles: true,
          ragDocuments: true,
          skills: true,
        },
        readOnlyTools: {
          time: true,
          webSearch: true,
          listWorkshopManifestCapabilities: true,
          reviewWorkshopManifestYaml: true,
          inspectWorkshopAgent: true,
          listKnowledgeBaseDocuments: true,
          getFullDocumentContent: true,
          searchKnowledgeBase: true,
          searchUnifiedMemory: true,
          searchMemoryPath: true,
          chatInsight: true,
          queryContacts: true,
          brainListMemories: true,
          brainListCandidates: true,
          brainListSnapshots: true,
          brainListGrants: true,
          listLoopTasks: true,
          wechatDesktopHealth: true,
        },
        controlledWriteTools: {
          setLoopTaskStatus: true,
        },
        reviewableWriteTools: {
          wechatDesktopPreviewMessage: true,
          proposeWorkshopAgentChange: true,
          proposeInsightChange: true,
          proposeWorkshopLoopTask: true,
          proposeWorkshopLoopChange: true,
        },
        claudeOnlyTools: {
          applyInsightChange: true,
          updateLoopTask: true,
          deleteLoopTask: true,
        },
        disabled: {
          mcp: true,
          sandbox: true,
          binaryFiles: true,
          images: true,
          externalActions: true,
        },
      },
    });
  });

  it("uses the explicit native default provider environment switch for Pi", async () => {
    vi.stubEnv("NATIVE_AGENT_DEFAULT_PROVIDER", "pi");

    const response = await GET();
    const payload = await response.json();

    expect(payload.defaultAgent).toBe("pi");
    expect(payload.defaultAgentSource).toBe("env");
    expect(resolveDefaultNativeAgentProvider()).toEqual({
      provider: "pi",
      source: "env",
    });
  });

  it("allows an explicit environment switch back to Claude", async () => {
    vi.stubEnv("NATIVE_AGENT_DEFAULT_PROVIDER", "claude");

    const response = await GET();
    const payload = await response.json();

    expect(payload.defaultAgent).toBe("claude");
    expect(payload.defaultAgentSource).toBe("env");
    expect(resolveDefaultNativeAgentProvider()).toEqual({
      provider: "claude",
      source: "env",
    });
  });

  it("ignores invalid native default provider values", () => {
    vi.stubEnv("NATIVE_AGENT_DEFAULT_PROVIDER", "deepagents");

    expect(normalizeNativeAgentProvider("deepagents")).toBeNull();
    expect(resolveDefaultNativeAgentProvider()).toEqual({
      provider: "pi",
      source: "default",
    });
  });
});
