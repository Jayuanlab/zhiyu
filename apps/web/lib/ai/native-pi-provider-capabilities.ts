import { isNativePiReadOnlyFileAttachment } from "@/lib/ai/native-pi-file-attachments-context";
import { NATIVE_PI_WEB_CHAT_TOOLS } from "@/lib/ai/native-pi-web-chat-tools";

export interface NativePiProviderCapabilityRequest {
  provider?: string;
  phase?: string;
  images?: unknown[];
  fileAttachments?: Array<{ name?: string; mimeType?: string | null }> | unknown[];
  ragDocuments?: unknown[];
  skillsConfig?: { enabled?: boolean } | null;
  mcpConfig?: { enabled?: boolean } | null;
  sandboxConfig?: unknown;
  permissionMode?: string | null;
  allowedTools?: unknown;
}

export interface NativePiProviderCapabilityBlock {
  status: 400;
  error: string;
  unsupportedCapabilities: string[];
}

export function getNativePiProviderCapabilityBlock(
  request: NativePiProviderCapabilityRequest,
): NativePiProviderCapabilityBlock | null {
  if (request.provider !== "pi") return null;

  const unsupportedCapabilities: string[] = [];
  const migratedToolNames = new Set<string>(NATIVE_PI_WEB_CHAT_TOOLS);
  const requestedTools = Array.isArray(request.allowedTools)
    ? request.allowedTools.filter(
        (toolName): toolName is string => typeof toolName === "string",
      )
    : [];
  for (const toolName of requestedTools) {
    if (!migratedToolNames.has(toolName)) {
      unsupportedCapabilities.push(`tools:${toolName}`);
    }
  }
  if ((request.images?.length ?? 0) > 0) {
    unsupportedCapabilities.push("images");
  }
  const fileAttachments = request.fileAttachments ?? [];
  if (
    fileAttachments.some((attachment) => {
      const item = attachment as { name?: string; mimeType?: string | null };
      return !isNativePiReadOnlyFileAttachment({
        name: item.name ?? "",
        mimeType: item.mimeType,
      });
    })
  ) {
    unsupportedCapabilities.push("file_attachments");
  }
  if (request.mcpConfig?.enabled) {
    unsupportedCapabilities.push("mcp");
  }
  if (request.sandboxConfig) {
    unsupportedCapabilities.push("sandbox");
  }
  if (request.permissionMode && request.permissionMode !== "default") {
    unsupportedCapabilities.push("permission_mode");
  }

  if (unsupportedCapabilities.length === 0) return null;

  return {
    status: 400,
    error:
      "Pi provider is currently enabled for text Web Chat runs with read-only time/webSearch/workshop manifest capability/review/agent inspection/knowledge document list/full document read/search/unified memory/memory path/chat insight/contact query/Brain read and grant list/Loop list/WeChat health tools, owner-scoped Loop status controls, owner-reviewable WeChat message previews, workshop change proposals, Insight change proposals, paused Loop task and Loop change proposals, read-only text attachments, PDF/Word text extraction, workspace text files, RAG, and skills context. Keep this request on Claude until these capabilities are migrated.",
    unsupportedCapabilities,
  };
}
