import { promises as fs } from "node:fs";
import path from "node:path";
import { isNativePiReadOnlyTextAttachment } from "@/lib/ai/native-pi-file-attachments-context";

export interface NativePiWorkspaceFileRef {
  taskId?: string;
  path: string;
  name?: string;
}

export const NATIVE_PI_WORKSPACE_FILE_TOTAL_CHAR_LIMIT = 16000;
export const NATIVE_PI_WORKSPACE_FILE_PER_FILE_CHAR_LIMIT = 6000;
export const NATIVE_PI_WORKSPACE_FILE_MAX_BYTES = 256 * 1024;

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 42)).trimEnd()}\n[truncated at ${limit} characters]`;
}

function escapeAttribute(value: string): string {
  return value.replace(/[<>"&]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "&":
        return "&amp;";
      default:
        return char;
    }
  });
}

function resolveWorkspaceFilePath(workDir: string, filePath: string): string | null {
  const base = path.resolve(workDir);
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(base, filePath);
  const relative = path.relative(base, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0);
}

export async function buildNativePiWorkspaceFileRefsContext(
  input: {
    workDir: string;
    refs: NativePiWorkspaceFileRef[];
  },
  options: {
    totalCharLimit?: number;
    perFileCharLimit?: number;
    maxBytes?: number;
  } = {},
): Promise<string> {
  const totalCharLimit =
    options.totalCharLimit ?? NATIVE_PI_WORKSPACE_FILE_TOTAL_CHAR_LIMIT;
  const perFileCharLimit =
    options.perFileCharLimit ?? NATIVE_PI_WORKSPACE_FILE_PER_FILE_CHAR_LIMIT;
  const maxBytes = options.maxBytes ?? NATIVE_PI_WORKSPACE_FILE_MAX_BYTES;
  const fileContexts: string[] = [];
  const warnings: string[] = [];

  for (const ref of input.refs) {
    const name = ref.name?.trim() || path.basename(ref.path);
    const resolvedPath = resolveWorkspaceFilePath(input.workDir, ref.path);
    if (!resolvedPath) {
      warnings.push(`- ${name}: skipped because the path is outside the workspace.`);
      continue;
    }
    if (!isNativePiReadOnlyTextAttachment({ name, mimeType: "text/plain" })) {
      warnings.push(`- ${name}: skipped because this file type is not text-like.`);
      continue;
    }

    try {
      const stats = await fs.stat(resolvedPath);
      if (!stats.isFile()) {
        warnings.push(`- ${name}: skipped because it is not a file.`);
        continue;
      }
      if (stats.size > maxBytes) {
        warnings.push(
          `- ${name}: skipped because it is larger than ${maxBytes} bytes.`,
        );
        continue;
      }

      const buffer = await fs.readFile(resolvedPath);
      if (looksBinary(buffer)) {
        warnings.push(`- ${name}: skipped because the content appears binary.`);
        continue;
      }

      const content = truncateText(buffer.toString("utf8").trim(), perFileCharLimit);
      if (!content) {
        warnings.push(`- ${name}: skipped because it is empty.`);
        continue;
      }
      fileContexts.push(
        [
          `<workspace-file name="${escapeAttribute(name)}" path="${escapeAttribute(ref.path)}">`,
          content,
          "</workspace-file>",
        ].join("\n"),
      );
    } catch (error) {
      warnings.push(
        `- ${name}: skipped because it could not be read (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  if (fileContexts.length === 0 && warnings.length === 0) return "";

  const body = truncateText(fileContexts.join("\n\n"), totalCharLimit);
  const warningText =
    warnings.length > 0
      ? `\n\nSkipped workspace files:\n${warnings.join("\n")}`
      : "";
  return `[System Note: The following user-selected workspace files are included as read-only text context for Pi. This snapshot does not grant file read, write, edit, shell, MCP, sandbox, or external action permissions.\n\n${body}${warningText}\n]\n\n`;
}
