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
    expect(routeSource).toContain('getNativePiProviderCapabilityBlock');
    expect(routeSource).not.toContain('ControlledClaude');
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
      "Unsupported native agent provider. Supported provider is pi.",
    );
    expect(routeSource).toContain("provider:${String(body.provider)}");
    expect(routeSource).toContain(
      "const defaultProviderSelection = resolveDefaultNativeAgentProvider()",
    );
    expect(routeSource).toContain(
      "let selectedProvider = explicitProvider ?? defaultProviderSelection.provider",
    );
    expect(routeSource).toContain('canonicalConversation.protocol');
    expect(routeSource).not.toContain('selectedProvider = "claude"');
    expect(routeSource).toContain("provider: selectedProvider");
    expect(routeSource).not.toContain('body.provider === "pi"');
    expect(routeSource).not.toContain('body.provider !== "pi"');
  });

  it("uses one owner-scoped canonical connection for every Pi protocol", () => {
    expect(routeSource).toContain('loadModelConfiguration');
    expect(routeSource).toContain("purpose:'agent'");
    expect(routeSource).toContain('assertModelSelectionOnly(body.modelConfig)');
    expect(routeSource).not.toContain('process.env.OPENCODE_API_KEY');
    expect(routeSource).not.toContain('resolveNativePiUserConfig(');
    expect(routeSource).toMatch(
      /provider:'pi',apiKey:effectivePiModelConfig\.apiKey,baseUrl:effectivePiModelConfig\.baseUrl,model:effectivePiModelConfig\.model/,
    );
    expect(routeSource).toContain("protocol:effectivePiModelConfig.protocol");
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

  it("uses only the host runtime tool set for Pi", () => {
    expect(routeSource).toContain("allowedTools?: string[]");
    expect(routeSource).not.toContain('register(claudePlugin)');
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
      /runtimeTools:[\s\S]+?selectedProvider === "pi"[\s\S]+?createNativePiWebChatTools\(\{[\s\S]+?userId: session\.user\.id,[\s\S]+?embeddingsAuthToken: body\.authToken,[\s\S]+?\}\)\.filter\(nativeToolFilter\)[\s\S]+?: undefined/,
    );
    expect(routeSource).toContain("onBeforeProviderRequest: assertMemoryDispatchCurrent");
    expect(routeSource).toContain("onRuntimeSelected: bindMemoryDispatchRuntime");
  });
});
