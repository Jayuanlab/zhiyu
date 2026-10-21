/**
 * File Operations API
 *
 * Single file read, open, and other operations
 *
 * Supports two modes:
 * 1. JSON mode (default): returns { content: string, filePath, isHtml }
 * 2. Binary mode: returns raw file content (triggered by Accept: image/*, application/pdf, etc.)
 */

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { chat } from "@/lib/db/schema";
import { getAuthMode, requestBoundary } from "@/lib/auth/request-boundary";
import { WorkspaceListingBoundaryError, resolveSessionListingPath } from "@/lib/files/workspace/listing-boundary";
import {
  deleteSessionFile,
  readSessionFile,
  readSessionFileBinary,
  getTaskSessionDir,
} from "@/lib/files/workspace/sessions";
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
async function ownsTask(userId: string, taskId: string) {
  const [owned] = await db.select({ id: chat.id }).from(chat).where(and(eq(chat.id, taskId), eq(chat.userId, userId))).limit(1);
  return !!owned;
}
function fileBoundary(taskId: string, filePath: string) {
  return resolveSessionListingPath(getTaskSessionDir(taskId), filePath);
}

// Image file extensions
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "bmp",
  "ico",
  "avif",
  "heic",
]);

// PDF file extensions
const PDF_EXTENSIONS = new Set(["pdf"]);

// Spreadsheet (requires `?binary=true` to fetch snapshot or download)
const SPREADSHEET_BINARY_EXTENSIONS = new Set([
  "xlsx",
  "xls",
  "xlsm",
  "ods",
  "csv",
]);

// Other binary file extensions
const BINARY_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...SPREADSHEET_BINARY_EXTENSIONS,
  "zip",
  "tar",
  "gz",
  "7z",
  "rar",
  "exe",
  "dll",
  "so",
  "dylib",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "webm",
  "mkv",
  "wav",
  "ogg",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  "bin",
  "dat",
  "pptx",
  "docx",
]);

// File extension to MIME type mapping
const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  heic: "image/heic",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  webm: "video/webm",
  mkv: "video/x-matroska",
  wav: "audio/wav",
  ogg: "audio/ogg",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  eot: "application/vnd.ms-fontobject",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv; charset=utf-8",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// GET /api/workspace/file/[taskId]/[...path] - Read file content
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  // Verify user authentication
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { path: pathParts } = await context.params;
    if (pathParts.length < 2) {
      return NextResponse.json(
        { error: "Invalid path format" },
        { status: 400 },
      );
    }

    const [taskId, ...filePathParts] = pathParts;
    const filePath = decodeURIComponent(filePathParts.join("/"));

    if (!taskId) {
      return NextResponse.json(
        { error: "taskId is required" },
        { status: 400 },
      );
    }
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(taskId)) return NextResponse.json({ error: "File unavailable" }, { status: 404, headers: privateHeaders });
    if (!await ownsTask(session.user.id, taskId)) return NextResponse.json({ error: "File unavailable" }, { status: 404, headers: privateHeaders });
    fileBoundary(taskId, filePath);

    // Check if binary file
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const isBinaryFile = BINARY_EXTENSIONS.has(ext);

    // Check if request headers expect binary response
    const acceptHeader = req.headers.get("accept") || "";
    const wantsBinary =
      acceptHeader.startsWith("image/") ||
      acceptHeader.startsWith("video/") ||
      acceptHeader.startsWith("audio/") ||
      acceptHeader.includes("application/pdf") ||
      acceptHeader.includes("octet-stream") ||
      req.nextUrl.searchParams.get("binary") === "true";

    // If binary file and request expects binary response, return binary data
    if (isBinaryFile && wantsBinary) {
      const binaryContent = readSessionFileBinary(taskId, filePath);

      if (binaryContent === null) {
        return NextResponse.json({ error: "File not found" }, { status: 404, headers: privateHeaders });
      }

      // Get MIME type
      const mimeType = MIME_TYPES[ext] || "application/octet-stream";

      // Return binary content
      return new NextResponse(new Uint8Array(binaryContent), {
        status: 200,
        headers: {
          "Content-Type": mimeType,
          ...privateHeaders,
          "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filePath.split(/[\\/]/).at(-1)?.replace(/[\r\n]/g, "") ?? "download").replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`,
          "Content-Security-Policy": "sandbox",
        },
      });
    }

    // Otherwise return JSON format
    const content = readSessionFile(taskId, filePath);

    if (content === null) {
      return NextResponse.json({ error: "File not found" }, { status: 404, headers: privateHeaders });
    }

    // Check if HTML file
    const isHtml =
      filePath.toLowerCase().endsWith(".html") ||
      filePath.toLowerCase().endsWith(".htm");

    return NextResponse.json({
      content,
      filePath,
      isHtml,
      isBinary: isBinaryFile,
      sourceControl: "legacy_workspace_owner_view_only",
      modelUse: "unsupported_without_registered_source",
    }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof WorkspaceListingBoundaryError) return NextResponse.json({ error: "File unavailable" }, { status: 403, headers: privateHeaders });
    if (error instanceof URIError) return NextResponse.json({ error: "Invalid file path" }, { status: 400, headers: privateHeaders });
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return NextResponse.json({ error: "File unavailable" }, { status: 404, headers: privateHeaders });
    console.error("[FileAPI] GET error:", error);
    return NextResponse.json(
      {
        error: "Failed to read file",
      },
      { status: 500, headers: privateHeaders },
    );
  }
}

// DELETE /api/workspace/file/[taskId]/[...path] - Delete file
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    if (requestBoundary(req, getAuthMode())) return NextResponse.json({ error: "Same-origin owner request required" }, { status: 403, headers: privateHeaders });
    const { path: pathParts } = await context.params;
    if (pathParts.length < 2) {
      return NextResponse.json(
        { error: "Invalid path format" },
        { status: 400 },
      );
    }

    const [taskId, ...filePathParts] = pathParts;
    const filePath = decodeURIComponent(filePathParts.join("/"));
    if (!taskId) {
      return NextResponse.json(
        { error: "taskId is required" },
        { status: 400 },
      );
    }
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(taskId)) return NextResponse.json({ error: "File unavailable" }, { status: 404, headers: privateHeaders });
    if (!await ownsTask(session.user.id, taskId)) return NextResponse.json({ error: "File unavailable" }, { status: 404, headers: privateHeaders });
    fileBoundary(taskId, filePath);

    const deleted = deleteSessionFile(taskId, filePath);
    if (!deleted) {
      return NextResponse.json(
        { error: "Failed to delete file" },
        { status: 404, headers: privateHeaders },
      );
    }

    return NextResponse.json({ success: true }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof WorkspaceListingBoundaryError) return NextResponse.json({ error: "File unavailable" }, { status: 403, headers: privateHeaders });
    if (error instanceof URIError) return NextResponse.json({ error: "Invalid file path" }, { status: 400, headers: privateHeaders });
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return NextResponse.json({ error: "File unavailable" }, { status: 404, headers: privateHeaders });
    console.error("[FileAPI] DELETE error:", error);
    return NextResponse.json(
      {
        error: "Failed to delete file",
      },
      { status: 500, headers: privateHeaders },
    );
  }
}
