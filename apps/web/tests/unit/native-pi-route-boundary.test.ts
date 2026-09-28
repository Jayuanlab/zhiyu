import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  join(process.cwd(), "app/api/native/agent/route.ts"),
  "utf8",
);

describe("native Pi route boundaries", () => {
  it("keeps focused insight tool instructions out of the Pi prompt branch", () => {
    const piFocusedInsightBranch = routeSource.match(
      /selectedProvider === "pi"\s*\?\s*`\[System Note: The user is focusing[\s\S]+?Do not claim to have file-system, MCP, sandbox, original binary\/PDF file, or external action access\.[\s\S]+?\n\]\\n\\n`/,
    )?.[0];

    expect(piFocusedInsightBranch).toBeTruthy();
    expect(piFocusedInsightBranch).not.toContain("MUST use the searchKnowledgeBase tool");
    expect(piFocusedInsightBranch).not.toContain("You can use searchKnowledgeBase tool");
    expect(piFocusedInsightBranch).toContain(
      "use the read-only knowledge-base tools when the document IDs are available",
    );
    expect(piFocusedInsightBranch).toContain(
      "Do not claim to have file-system, MCP, sandbox, original binary/PDF file, or external action access.",
    );
  });

  it("does not save RAG documents to the workspace for Pi", () => {
    expect(routeSource).toContain('selectedProvider !== "pi"');
    expect(routeSource).toMatch(
      /body\.ragDocuments &&[\s\S]+?body\.workDir &&[\s\S]+?selectedProvider !== "pi"[\s\S]+?saveRAGDocumentsToWorkspace/,
    );
  });

  it("injects selected workspace file references into Pi as bounded read-only context", () => {
    expect(routeSource).toContain("buildNativePiWorkspaceFileRefsContext");
    expect(routeSource).toMatch(
      /selectedProvider === "pi"[\s\S]+?body\.workspaceFileRefs[\s\S]+?body\.workDir[\s\S]+?buildNativePiWorkspaceFileRefsContext/,
    );
    expect(routeSource).toContain(
      "Injecting Pi workspace file refs into prompt",
    );
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
    expect(routeSource).toContain("const effectivePiModelConfig = {");
    expect(routeSource).toMatch(
      /const effectivePiModelConfig = \{[\s\S]+?\.\.\.piModelConfig,[\s\S]+?\.\.\.body\.modelConfig,[\s\S]+?\.\.\.userOpenAiConfig,[\s\S]+?\}/,
    );
    expect(routeSource).toMatch(
      /selectedProvider === "pi"[\s\S]+?apiKey: effectivePiModelConfig\.apiKey,[\s\S]+?baseUrl: effectivePiModelConfig\.baseUrl,[\s\S]+?model: effectivePiModelConfig\.model,/,
    );
    expect(routeSource).toMatch(
      /createPiOpenAICompatibleResponse\([\s\S]+?body,[\s\S]+?userOpenAiConfig,[\s\S]+?\)/,
    );
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

  it("passes no tool, MCP, sandbox, or permission mode options to Pi", () => {
    expect(routeSource).toContain("allowedTools?: string[]");
    expect(routeSource).toContain(
      "before clearing SDK tools and using its migrated runtimeTools set",
    );
    expect(routeSource).toContain(
      'sandbox: selectedProvider === "pi" ? undefined : body.sandboxConfig',
    );
    expect(routeSource).toContain(
      'mcpConfig: selectedProvider === "pi" ? undefined : body.mcpConfig',
    );
    expect(routeSource).toContain(
      'selectedProvider === "pi" ? undefined : body.permissionMode',
    );
    expect(routeSource).toMatch(
      /allowedTools:\s*selectedProvider === "pi"\s*\?\s*\[\]\s*:/,
    );
    expect(routeSource).toMatch(
      /selectedProvider === "pi"\s*\?\s*createNativePiWebChatTools\(\{\s*userId: session\.user\.id,\s*embeddingsAuthToken: body\.authToken,\s*\}\)\s*:\s*undefined/,
    );
  });
});
