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
      "This Web request exceeds its host-registered tools or managed-source permissions. Use the registered Pi tools and import/bind supported sources. Dynamic MCP, sandbox, raw images and permissive tool modes require a separately authorized host configuration; changing the model protocol does not grant these permissions.",
    unsupportedCapabilities,
  };
}
