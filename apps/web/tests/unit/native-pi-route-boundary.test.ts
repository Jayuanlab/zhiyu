import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  join(process.cwd(), "app/api/native/agent/route.ts"),
  "utf8",
);

describe("native Pi route boundaries", () => {
  it("withholds cached focused insights rather than treating their prose as a source", () => {
    expect(routeSource).toContain('unregisteredSourceGap("focused_insights_and_notes")');
    expect(routeSource).not.toContain("insight.details");
    expect(routeSource).not.toContain("insight.notes");
  });

  it("has no raw RAG-to-workspace copy path and requires controlled source runtimes", () => {
    expect(routeSource).not.toContain("saveRAGDocumentsToWorkspace");
    expect(routeSource).not.toContain("getDocumentChunks");
    expect(routeSource).toContain("error: 'memory_source_runtime_unsupported'");
    expect(routeSource).toContain('Controlled Claude Web requires an authenticated Anthropic-compatible provider saved on the server');
    expect(routeSource).toContain("admitMemorySourceUse");
  });

  it("imports an actual current owner selection before admitting its managed artifact windows", () => {
    expect(routeSource).toContain("importOwnerWorkspaceFileRefs");
    expect(routeSource).not.toContain("buildNativePiWorkspaceFileRefsContext");
    expect(routeSource).toMatch(
      /importOwnerWorkspaceFileRefs\(\{\s*userId: session\.user\.id,[\s\S]+?refs: body\.workspaceFileRefs/,
    );
    expect(routeSource).toContain('admitExactArtifactUse');
    expect(routeSource).toContain("purpose: 'current_selected_workspace_files'");
    expect(routeSource).toContain('workspace_import_command_required');
  });

  it("uses one selected provider for defaulting and Pi capability boundaries", () => {
    expect(routeSource).toContain("normalizeNativeAgentProvider");
    expect(routeSource).toContain(
      "Unsupported native agent provider. Supported providers are claude and pi.",
    );
    expect(routeSource).toContain("provider:${String(body.provider)}");
    expect(routeSource).toContain(
      "const defaultProviderSelection = resolveDefaultNativeAgentProvider()",
    );
    expect(routeSource).toContain(
      "let selectedProvider = explicitProvider ?? defaultProviderSelection.provider",
    );
    expect(routeSource).toContain("const hasClaudeNativeConfig = Boolean(");
    expect(routeSource).toContain('selectedProvider === "claude"');
    expect(routeSource).toContain(
      'defaultProviderSelection.provider === "pi"',
    );
    expect(routeSource).toContain('selectedProvider = "claude"');
    expect(routeSource).toContain("provider: selectedProvider");
    expect(routeSource).not.toContain('body.provider === "pi"');
    expect(routeSource).not.toContain('body.provider !== "pi"');
  });

  it("uses user-saved OpenAI-compatible settings for Pi web chat configuration", () => {
    expect(routeSource).toContain('providerType: "openai_compatible"');
    expect(routeSource).toContain("process.env.OPENCODE_API_KEY");
    expect(routeSource).toContain(
      "process.env.INTERACTION_PROCESSOR_LLM_BASE_URL",
    );
    expect(routeSource).toContain('baseUrl?.includes("opencode.ai/zen/go")');
    expect(routeSource).toContain('"openai-completions"');
    expect(routeSource).toContain("const userOpenAiConfig");
    expect(routeSource).toMatch(
      /const effectivePiModelConfig = resolveNativePiUserConfig\(\{ env: piModelConfig,[\s\S]+?request: body\.modelConfig, openAI: userOpenAiConfig, anthropic: userAnthropicConfig \}\)/,
    );
    expect(routeSource).toMatch(
      /selectedProvider === "pi"[\s\S]+?apiKey: effectivePiModelConfig\.apiKey,[\s\S]+?baseUrl: effectivePiModelConfig\.baseUrl,[\s\S]+?model: effectivePiModelConfig\.model,/,
    );
    expect(routeSource).toContain("protocol: effectivePiModelConfig.protocol");
  });

  it("keeps typed WeChat send confirmation compatible with Pi preview tool output", () => {
    expect(routeSource).toContain("function isWechatDesktopPreviewToolName");
    expect(routeSource).toContain('toolName === "wechatDesktopPreviewMessage"');
    expect(routeSource).toContain(
      'toolName === "mcp__business-tools__wechatDesktopPreviewMessage"',
    );
    expect(routeSource).toContain(
      'toolName.endsWith("__wechatDesktopPreviewMessage")',
    );
    expect(routeSource).toContain(
      'const content = typeof output === "string" ? JSON.parse(output) : output',
    );
  });

  it("uses only the host runtime tool set for Pi and controlled Claude", () => {
    expect(routeSource).toContain("allowedTools?: string[]");
    expect(routeSource).toContain(
      "before clearing SDK tools and using its migrated runtimeTools set",
    );
    expect(routeSource).toContain(
      'sandbox: undefined',
    );
    expect(routeSource).toContain(
      'mcpConfig: undefined',
    );
    expect(routeSource).toContain(
      'permissionMode: undefined',
    );
    expect(routeSource).toMatch(
      /allowedTools:\s*\[\]/,
    );
    expect(routeSource).toMatch(
      /runtimeTools:[\s\S]+?selectedProvider === "pi" \|\| selectedProvider === 'claude'[\s\S]+?createNativePiWebChatTools\(\{[\s\S]+?userId: session\.user\.id,[\s\S]+?embeddingsAuthToken: body\.authToken,[\s\S]+?\}\)\.filter\(nativeToolFilter\)[\s\S]+?: undefined/,
    );
    expect(routeSource).toContain("onBeforeProviderRequest: assertMemoryDispatchCurrent");
    expect(routeSource).toContain("onRuntimeSelected: bindMemoryDispatchRuntime");
  });
});
