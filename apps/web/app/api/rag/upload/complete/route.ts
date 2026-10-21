import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { parseFile } from "@/lib/files/parsers";
import { randomUUID } from "node:crypto";
import {
  SUPPORTED_RAG_MIME_TYPES,
  getMimeTypeFromExtension,
} from "@/lib/files/config";
import { uploadFile } from "@/lib/storage";
import { runRagIndexDocumentJob } from "@/lib/runtime-worker/rag-indexing";

const UPLOAD_TEMP_DIR = path.join(tmpdir(), "openzhiyu-uploads");

/**
 * Complete chunked upload - Merge all chunks and process document
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: userId, type: userType } = session.user;

  try {
    const body = await request.json();
    const { uploadId, fileName, contentType, cloudAuthToken } = body;

    if (!uploadId || !fileName) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    const uploadDir = path.join(UPLOAD_TEMP_DIR, uploadId);

    // Check if upload directory exists
    if (!existsSync(uploadDir)) {
      return NextResponse.json(
        { error: "Upload session not found or expired" },
        { status: 404 },
      );
    }

    console.log(
      `[Upload Complete] Starting merge for ${uploadId}, file: ${fileName}`,
    );

    // Get all chunks and sort them
    const files = await readdir(uploadDir);
    const chunkFiles = files.filter((f) => f.startsWith("chunk_")).sort(); // chunk_000000, chunk_000001, etc.

    if (chunkFiles.length === 0) {
      return NextResponse.json({ error: "No chunks found" }, { status: 400 });
    }

    console.log(
      `[Upload Complete] Found ${chunkFiles.length} chunks, merging...`,
    );

    // Merge all chunks
    const chunks: Buffer[] = [];
    for (const chunkFile of chunkFiles) {
      const chunkPath = path.join(uploadDir, chunkFile);
      const chunkBuffer = await readFile(chunkPath);
      chunks.push(chunkBuffer);
    }

    const totalBuffer = Buffer.concat(chunks);
    console.log(
      `[Upload Complete] Merged ${chunks.length} chunks, total size: ${totalBuffer.length} bytes`,
    );

    // Clean up temporary files
    await rm(uploadDir, { recursive: true, force: true });
    console.log(
      `[Upload Complete] Cleaned up temporary directory: ${uploadDir}`,
    );

    // Process file type
    let finalContentType = contentType;
    const fileExtension = fileName.toLowerCase().split(".").pop();

    if (
      !finalContentType ||
      finalContentType === "" ||
      finalContentType === "application/octet-stream"
    ) {
      const inferredMimeType = getMimeTypeFromExtension(`.${fileExtension}`);
      finalContentType = inferredMimeType || "text/plain";
    } else if (fileExtension === "md" && finalContentType === "text/plain") {
      finalContentType = "text/markdown";
    }

    // Check if file type is supported
    if (!SUPPORTED_RAG_MIME_TYPES.includes(finalContentType as any)) {
      return NextResponse.json(
        {
          error: `Unsupported file type for RAG. Supported types: ${SUPPORTED_RAG_MIME_TYPES.join(", ")}`,
        },
        { status: 415 },
      );
    }

    // Parse file content
    console.log("[Upload Complete] Parsing file content...", {
      fileName,
      contentType: finalContentType,
      fileSize: totalBuffer.length,
    });
    const { text: content, metadata } = await parseFile(
      totalBuffer,
      finalContentType,
      cloudAuthToken, // Pass cloudAuthToken for image processing
    );

    console.log("[Upload Complete] Parse result:", {
      contentLength: content?.length || 0,
      hasContent: !!content,
      metadata,
    });

    // Check content length - if too short, it's a scanned PDF (only metadata)
    const MIN_CONTENT_LENGTH = 100; // Minimum content length
    if (!content || content.trim().length < MIN_CONTENT_LENGTH) {
      // Clean up temporary directory
      await rm(uploadDir, { recursive: true, force: true });

      // Provide more specific error message
      let errorMessage = "No text content could be extracted from file";
      if (finalContentType === "application/pdf") {
        errorMessage =
          "No text content could be extracted from PDF. This may be a scanned document or image-based PDF. Please convert it to a text-based PDF or use OCR first.";
      }

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    console.log(
      `[Upload Complete] File parsed, content length: ${content.length}`,
    );

    // Upload original file to storage system (for retrieving original file during workspace export)
    let blobPath: string | undefined;
    let originalStorage = { status: "unavailable", provider: "memory_artifacts", detail: "original_not_persisted",
      warning: "The original file was not persisted; indexing results do not provide a controlled original file." };
    try {
      const uploadResult = await uploadFile({ userId, pathname: `rag/${randomUUID()}-${fileName}`, data: totalBuffer, contentType: finalContentType });
      blobPath = uploadResult.pathname;
      originalStorage = { status: "active", provider: "memory_artifacts", detail: "private_owner_manifest", warning: "" };
      console.log(
        `[Upload Complete] Original file saved to storage: ${blobPath}`,
      );
    } catch (error) {
      console.error(
        "[Upload Complete] Failed to save original file to storage:",
        error,
      );
      // Continue processing, doesn't affect RAG functionality
    }

    // Run RAG indexing through the worker contract. This adapter is synchronous
    // today, but the route no longer owns the indexing implementation.
    const result = await runRagIndexDocumentJob({
      userId,
      userType,
      fileName,
      contentType: finalContentType,
      content,
      blobPath,
      authToken: cloudAuthToken || undefined,
    });

    console.log(
      `[Upload Complete] Document processed, chunks: ${result.chunksCount}`,
    );

    return NextResponse.json({
      success: true,
      message: "Document successfully processed and added to strategy memory",
      documentId: result.documentId,
      originalStorage,
      fileName,
      contentType: finalContentType,
      extractedLength: content.length,
      chunksCount: result.chunksCount,
      metadata,
      billing: {
        tokensUsed: result.totalTokensUsed,
        creditCost: result.totalCreditCost,
      },
      stats: {
        totalDocuments: result.stats.totalDocuments,
        totalChunks: result.stats.totalChunks,
      },
    });
  } catch (error) {
    console.error("[Upload Complete] Error:", error);

    // Handle quota error
    if (
      error instanceof Error &&
      error.message.includes("Insufficient quota")
    ) {
      return NextResponse.json(
        { error: error.message, code: "INSUFFICIENT_QUOTA" },
        { status: 402 },
      );
    }

    // Try to clean up temporary directory
    // Note: Since body is declared in try block, need to re-fetch or pass uploadId here
    // This catch block cannot access variables in try block, so temporary directory cleanup is already done in try block

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to complete upload",
      },
      { status: 500 },
    );
  }
}
