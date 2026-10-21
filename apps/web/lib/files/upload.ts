/**
 * File upload helper functions
 *
 * For large files (>8MB) use chunked upload, for small files use regular upload
 */
import { uploadRagFileChunked, shouldUseChunkedUpload } from "./chunked-upload";
import { convertPDFToImages } from "./pdf-ocr";
const fileUploadCommands = new WeakMap<File, string>();

/**
 * Upload file to /api/files/upload
 */
export async function uploadFile(
  file: File,
  options?: {
    createRecord?: boolean;
    commandId?: string;
  },
): Promise<{
  url: string;
  pathname: string;
  downloadUrl?: string;
  name: string;
  sanitizedName: string;
  contentType: string;
  size: number;
  blobPath: string;
  creditsDeducted?: number;
  savedFile?: any;
  usage?: any;
}> {
  const createRecord = options?.createRecord === false ? "false" : "true";

  // Use FormData for upload
  const formData = new FormData();
  formData.append("file", file);
  formData.append("createRecord", createRecord);
  const commandId = options?.commandId ?? fileUploadCommands.get(file) ?? crypto.randomUUID();
  fileUploadCommands.set(file, commandId);
  formData.append("commandId", commandId);

  const response = await fetch("/api/files/upload", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "File upload failed");
  }

  return response.json();
}

/**
 * Upload file to /api/rag/upload
 * Automatically choose chunked upload or regular upload
 */
export async function uploadRagFile(
  file: File,
  options?: {
    cloudAuthToken?: string;
    onProgress?: (
      fileName: string,
      progress: number,
      uploadedBytes: number,
      totalBytes: number,
    ) => void;
  },
): Promise<{
  success: boolean;
  message: string;
  fileName: string;
  contentType: string;
  extractedLength: number;
  chunksCount: number;
  documentId: string;
  metadata: any;
  billing: {
    tokensUsed: number;
    creditCost: number;
  };
  stats: {
    totalDocuments: number;
    totalChunks: number;
  };
  tip: string;
  error?: string;
}> {
  // Determine if chunked upload is needed
  if (shouldUseChunkedUpload(file)) {
    console.log(`[uploadRagFile] Using chunked upload for ${file.name}`);
    const result = await uploadRagFileChunked(file, {
      chunkSize: 5 * 1024 * 1024, // 5MB
      maxRetries: 3,
      onProgress: options?.onProgress,
      cloudAuthToken: options?.cloudAuthToken,
    });

    if (!result.success) {
      // Check if it's a scanned PDF - try image conversion
      const isScannedPDF =
        file.name.toLowerCase().endsWith(".pdf") &&
        (result.error?.includes("No text content") ||
          result.error?.includes("scanned"));

      if (isScannedPDF) {
        console.log(
          "[uploadRagFile] Chunked upload detected scanned PDF, converting to images...",
        );
        return await handleScannedPDFUpload(file, options);
      }

      throw new Error(result.error || "Document upload failed");
    }

    return {
      success: true,
      message: result.success ? "Document successfully processed" : "",
      fileName: result.fileName || file.name,
      contentType: result.contentType || file.type,
      extractedLength: result.extractedLength || 0,
      chunksCount: result.chunksCount || 0,
      documentId: result.documentId || "",
      metadata: {},
      billing: result.billing || { tokensUsed: 0, creditCost: 0 },
      stats: result.stats || { totalDocuments: 0, totalChunks: 0 },
      tip: "",
    };
  }

  // Regular upload (small files)
  console.log(`[uploadRagFile] Using normal upload for ${file.name}`);
  const formData = new FormData();
  formData.append("file", file);

  if (options?.cloudAuthToken) {
    formData.append("cloudAuthToken", options.cloudAuthToken);
  }

  // Don't use AbortController to avoid possible timeout issues
  // Tauri internal communication may have its own timeout mechanism

  let response: Response;
  try {
    console.log("[uploadRagFile] Starting fetch request...");
    response = await fetch("/api/rag/upload", {
      method: "POST",
      body: formData,
      // Ensure keep-alive is not used
      keepalive: false,
      // Explicitly set mode
      mode: "same-origin",
      credentials: "same-origin",
    });
    console.log(
      "[uploadRagFile] Fetch completed, status:",
      response.status,
      "statusText:",
      response.statusText,
    );
    console.log(
      "[uploadRagFile] Response headers:",
      Object.fromEntries(response.headers.entries()),
    );
  } catch (fetchError) {
    console.error("[uploadRagFile] Fetch error:", fetchError);
    if (fetchError instanceof Error && fetchError.name === "AbortError") {
      throw new Error("Upload timeout, please retry or use a smaller file");
    }
    throw fetchError;
  }

  if (!response.ok) {
    console.log("[uploadRagFile] Response not OK, status:", response.status);
    let errorText: string;
    try {
      errorText = await response.text();
      console.log(
        "[uploadRagFile] Error response text:",
        errorText.substring(0, 500),
      );
    } catch {
      errorText = "Unable to read error response";
    }
    let error: { error?: string };
    try {
      error = JSON.parse(errorText);
    } catch {
      error = { error: errorText };
    }

    // Check if it's a scanned PDF - try image conversion
    const isScannedPDF =
      file.name.toLowerCase().endsWith(".pdf") &&
      (error.error?.includes("No text content") ||
        error.error?.includes("scanned"));

    if (isScannedPDF) {
      console.log(
        "[uploadRagFile] Detected scanned PDF (normal upload), converting to images...",
      );
      return await handleScannedPDFUpload(file, options);
    }

    throw new Error(error.error || "Document upload failed");
  }

  console.log("[uploadRagFile] Reading response text first...");
  let responseText: string;
  try {
    responseText = await response.text();
    console.log("[uploadRagFile] Response text length:", responseText.length);
    console.log(
      "[uploadRagFile] Response text preview:",
      responseText.substring(0, 200),
    );
  } catch (textError) {
    console.error("[uploadRagFile] Failed to read response text:", textError);
    throw new Error(
      "Upload successful but failed to read response, please refresh the page to check if uploaded",
    );
  }

  console.log("[uploadRagFile] Parsing response JSON...");
  try {
    const jsonData = JSON.parse(responseText);
    console.log("[uploadRagFile] Response JSON parsed successfully");
    return jsonData;
  } catch (jsonError) {
    console.error("[uploadRagFile] Failed to parse response JSON:", jsonError);
    console.error("[uploadRagFile] Raw response:", responseText);
    throw new Error(
      "Upload successful but failed to read response, please refresh the page to check if uploaded",
    );
  }
}

/**
 * Handle scanned PDF upload by converting to images and uploading via image RAG
 */
export async function handleScannedPDFUpload(
  file: File,
  options?: {
    cloudAuthToken?: string;
    onProgress?: (
      fileName: string,
      progress: number,
      uploadedBytes: number,
      totalBytes: number,
    ) => void;
  },
): Promise<{
  success: boolean;
  message: string;
  fileName: string;
  contentType: string;
  extractedLength: number;
  chunksCount: number;
  documentId: string;
  metadata: any;
  billing: { tokensUsed: number; creditCost: number };
  stats: { totalDocuments: number; totalChunks: number };
  tip: string;
}> {
  // Convert PDF pages to images
  const { images } = await convertPDFToImages(file);

  console.log(
    `[handleScannedPDFUpload] Converted PDF to ${images.length} images`,
  );

  // Upload each page as an image via image RAG pipeline (parallel, batch of 5)
  const documentIds: string[] = [];
  let totalTokens = 0;
  let totalCredits = 0;
  const BATCH_SIZE = 5;

  async function uploadSinglePage(
    image: Blob,
    pageIndex: number,
  ): Promise<{
    documentId: string;
    tokens: number;
    credits: number;
  }> {
    const formData = new FormData();
    formData.append("file", image);

    if (options?.cloudAuthToken) {
      formData.append("cloudAuthToken", options.cloudAuthToken);
    }

    // Start async upload
    const response = await fetch("/api/rag/upload/async", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to upload page ${pageIndex + 1}: ${error.error}`);
    }

    const { jobId } = await response.json();

    // Poll for status
    const maxAttempts = 300; // 5 minutes max
    let attempts = 0;

    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const statusResponse = await fetch(
        `/api/rag/upload/async/status?jobId=${jobId}`,
      );
      const status = await statusResponse.json();

      // Report progress
      options?.onProgress?.(file.name, status.progress / 100, pageIndex, 0);

      if (status.status === "completed") {
        return {
          documentId: status.result?.documentId || "",
          tokens: status.result?.billing?.tokensUsed || 0,
          credits: status.result?.billing?.creditCost || 0,
        };
      }

      if (status.status === "failed") {
        throw new Error(
          `Failed to process page ${pageIndex + 1}: ${status.error}`,
        );
      }

      attempts++;
    }

    throw new Error(`Timeout waiting for page ${pageIndex + 1} to process`);
  }

  // Process in batches of 5
  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    const batch = images.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map((image, batchIndex) =>
      uploadSinglePage(image, i + batchIndex),
    );

    const results = await Promise.all(batchPromises);

    for (const result of results) {
      if (result.documentId) {
        documentIds.push(result.documentId);
        totalTokens += result.tokens;
        totalCredits += result.credits;
      }
    }

    // Report progress
    const completedPages = Math.min(i + BATCH_SIZE, images.length);
    const progress = completedPages / images.length;
    options?.onProgress?.(file.name, progress, completedPages, images.length);

    console.log(
      `[handleScannedPDFUpload] Uploaded pages ${i + 1}-${Math.min(i + BATCH_SIZE, images.length)} of ${images.length}`,
    );
  }

  return {
    success: true,
    message: `Successfully uploaded ${images.length} pages from scanned PDF`,
    fileName: file.name,
    contentType: "image/png",
    extractedLength: 0,
    chunksCount: documentIds.length,
    documentId: documentIds[0] || "",
    metadata: { scannedPDF: true, pageCount: images.length },
    billing: { tokensUsed: totalTokens, creditCost: totalCredits },
    stats: {
      totalDocuments: documentIds.length,
      totalChunks: documentIds.length,
    },
    tip: "",
  };
}
