import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { getAppDir } from "@/lib/env/config/constants";

export type BailianVideoTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "UNKNOWN";

export interface BailianVideoGenerateInput {
  prompt: string;
  negativePrompt?: string;
  model?: string;
  ratio?: "9:16" | "16:9" | "1:1" | "4:3" | "3:4";
  resolution?: "480P" | "720P" | "1080P";
  durationSeconds?: number;
  promptExtend?: boolean;
  watermark?: boolean;
  taskId?: string;
  poll?: boolean;
  maxWaitSeconds?: number;
  outputFileName?: string;
  userId?: string;
  workshopId?: string;
  runId?: string | null;
}

export interface BailianVideoGenerateResult {
  ok: boolean;
  provider: "bailian";
  model: string;
  taskId: string | null;
  status: BailianVideoTaskStatus;
  videoUrl: string | null;
  localPath: string | null;
  prompt: string;
  submitPayload?: Record<string, unknown>;
  raw?: unknown;
  error?: string;
  warnings: string[];
  submittedAt?: string;
  completedAt?: string;
}

const DEFAULT_MODEL = "wan2.7-t2v-2026-06-12";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MAX_PROMPT_CHARS = 1800;

function envValue(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (!value) continue;
    if (/^\$[A-Z0-9_]+$/i.test(value)) {
      const referenced = process.env[value.slice(1)]?.trim();
      if (referenced) return referenced;
      continue;
    }
    return value;
  }
  return undefined;
}

function getApiKey() {
  return envValue(
    "AI_VIDEO_AGENT_VIDEO_API_KEY",
    "AI_VIDEO_AGENT_WAN_API_KEY",
    "BAILIAN_VIDEO_API_KEY",
    "DASHSCOPE_API_KEY",
    "BAILIAN_API_KEY",
  );
}

function getExplicitEndpoint() {
  return envValue(
    "AI_VIDEO_AGENT_VIDEO_ENDPOINT",
    "AI_VIDEO_AGENT_WAN_ENDPOINT",
    "DASHSCOPE_VIDEO_ENDPOINT",
    "BAILIAN_VIDEO_ENDPOINT",
  );
}

function getRegion() {
  return (
    envValue(
      "AI_VIDEO_AGENT_VIDEO_REGION",
      "AI_VIDEO_AGENT_WAN_REGION",
      "BAILIAN_VIDEO_REGION",
      "DASHSCOPE_REGION",
      "BAILIAN_REGION",
    ) ?? "cn-beijing"
  );
}

function getPublicRegionHost(region: string) {
  const hostByRegion: Record<string, string> = {
    "cn-beijing": "dashscope.aliyuncs.com",
    "ap-southeast-1": "dashscope-intl.aliyuncs.com",
  };
  return hostByRegion[region] ?? null;
}

function getRegionHost(region: string) {
  const hostByRegion: Record<string, string> = {
    "cn-beijing": "cn-beijing.maas.aliyuncs.com",
    "ap-southeast-1": "ap-southeast-1.maas.aliyuncs.com",
    "eu-central-1": "eu-central-1.maas.aliyuncs.com",
  };
  return hostByRegion[region] ?? `${region}.maas.aliyuncs.com`;
}

function getBaseUrl() {
  const raw = envValue(
    "AI_VIDEO_AGENT_VIDEO_BASE_URL",
    "AI_VIDEO_AGENT_WAN_BASE_URL",
    "BAILIAN_VIDEO_BASE_URL",
    "DASHSCOPE_VIDEO_BASE_URL",
  );
  if (raw) return raw.replace(/\/+$/g, "");
  const workspaceId = getWorkspaceId();
  const region = getRegion();
  if (workspaceId) {
    return `https://${workspaceId}.${getRegionHost(region)}/api/v1`;
  }
  const publicHost = getPublicRegionHost(region);
  if (publicHost) return `https://${publicHost}/api/v1`;
  return DEFAULT_BASE_URL;
}

function getWorkspaceId() {
  return envValue(
    "AI_VIDEO_AGENT_VIDEO_WORKSPACE_ID",
    "AI_VIDEO_AGENT_WAN_WORKSPACE_ID",
    "BAILIAN_VIDEO_WORKSPACE_ID",
    "DASHSCOPE_WORKSPACE_ID",
    "BAILIAN_WORKSPACE_ID",
  );
}

function normalizeStatus(value: unknown): BailianVideoTaskStatus {
  const status = String(value ?? "").toUpperCase();
  if (
    status === "PENDING" ||
    status === "RUNNING" ||
    status === "SUCCEEDED" ||
    status === "FAILED" ||
    status === "CANCELED"
  ) {
    return status;
  }
  return "UNKNOWN";
}

function baseEndpointPath(path: string) {
  const baseUrl = getBaseUrl();
  const workspaceId = getWorkspaceId();
  if (workspaceId && baseUrl.includes("{WorkspaceId}")) {
    return `${baseUrl.replace("{WorkspaceId}", workspaceId)}${path}`;
  }
  return `${baseUrl}${path}`;
}

function createEndpoint() {
  return (
    getExplicitEndpoint() ??
    baseEndpointPath("/services/aigc/video-generation/video-synthesis")
  );
}

function taskEndpoint(taskId: string) {
  const endpoint = getExplicitEndpoint();
  if (endpoint) {
    const marker = "/api/v1/";
    const index = endpoint.indexOf(marker);
    if (index !== -1) {
      return `${endpoint.slice(0, index + marker.length)}tasks/${taskId}`;
    }
  }
  return baseEndpointPath(`/tasks/${taskId}`);
}

async function fetchJson(input: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) {
      const message =
        typeof parsed === "object" && parsed && "message" in parsed
          ? String((parsed as { message?: unknown }).message)
          : text || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function findTaskId(payload: unknown): string | null {
  const record = asRecord(payload);
  const output = asRecord(record.output);
  const candidates = [
    output.task_id,
    output.taskId,
    record.task_id,
    record.taskId,
    asRecord(record.data).task_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function findVideoUrl(payload: unknown): string | null {
  const record = asRecord(payload);
  const output = asRecord(record.output);
  const results = Array.isArray(output.results) ? output.results : [];
  const candidates: unknown[] = [
    output.video_url,
    output.videoUrl,
    output.url,
    asRecord(output.video).url,
    asRecord(record.data).video_url,
  ];
  for (const result of results) {
    const item = asRecord(result);
    candidates.push(item.url, item.video_url, item.videoUrl);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findTaskStatus(payload: unknown): BailianVideoTaskStatus {
  const record = asRecord(payload);
  const output = asRecord(record.output);
  return normalizeStatus(
    output.task_status ??
      output.taskStatus ??
      output.status ??
      record.task_status ??
      record.status,
  );
}

function safeFileName(value: string) {
  const name = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows filenames forbid ASCII control characters.
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return name || `bailian-video-${randomUUID()}`;
}

function defaultOutputDir(input: BailianVideoGenerateInput) {
  const scope = input.workshopId
    ? join("workshops", input.workshopId, input.runId ?? "manual")
    : join("video", input.userId ?? "default");
  return join(getAppDir(), "generated-videos", scope);
}

async function downloadVideo(input: {
  url: string;
  outputDir: string;
  fileName?: string;
}) {
  const response = await fetch(input.url);
  if (!response.ok) {
    throw new Error(`Video download failed with HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(input.outputDir, { recursive: true });
  const urlPath = new URL(input.url).pathname;
  const extension = extname(urlPath).toLowerCase() || ".mp4";
  const hash = createHash("sha256").update(input.url).digest("hex").slice(0, 8);
  const baseName = safeFileName(input.fileName ?? `bailian-video-${hash}`);
  const filePath = join(input.outputDir, `${baseName}${extension}`);
  await writeFile(filePath, buffer);
  return filePath;
}

async function submitTextToVideo(input: BailianVideoGenerateInput) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "Missing Bailian video API key. Set BAILIAN_VIDEO_API_KEY, DASHSCOPE_API_KEY, or BAILIAN_API_KEY.",
    );
  }

  const model =
    input.model?.trim() ||
    envValue("AI_VIDEO_AGENT_VIDEO_MODEL", "BAILIAN_VIDEO_MODEL") ||
    DEFAULT_MODEL;
  const prompt = input.prompt.trim().slice(0, MAX_PROMPT_CHARS);
  const parameters: Record<string, unknown> = {
    resolution: input.resolution ?? "720P",
    prompt_extend: input.promptExtend ?? true,
    watermark: input.watermark ?? true,
  };
  const ratio = input.ratio ?? "9:16";
  if (model.startsWith("wan2.7")) {
    parameters.ratio = ratio;
  } else {
    parameters.size = ratio === "16:9" ? "1280*720" : "720*1280";
  }
  if (input.durationSeconds) {
    parameters.duration = Math.max(5, Math.min(15, input.durationSeconds));
  }

  const payload = {
    model,
    input: {
      prompt,
      negative_prompt: input.negativePrompt?.trim() || undefined,
    },
    parameters,
  };

  const raw = await fetchJson(
    createEndpoint(),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify(payload),
    },
  );
  const taskId = findTaskId(raw);
  if (!taskId) {
    throw new Error("Bailian video task response did not include task_id.");
  }
  return { raw, taskId, model, prompt, payload };
}

export async function queryBailianVideoTask(taskId: string) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "Missing Bailian video API key. Set BAILIAN_VIDEO_API_KEY, DASHSCOPE_API_KEY, or BAILIAN_API_KEY.",
    );
  }
  const raw = await fetchJson(taskEndpoint(taskId), {
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
  });
  return {
    raw,
    status: findTaskStatus(raw),
    videoUrl: findVideoUrl(raw),
  };
}

export async function generateBailianInvestmentVideo(
  input: BailianVideoGenerateInput,
): Promise<BailianVideoGenerateResult> {
  const warnings: string[] = [];
  try {
    const model =
      input.model?.trim() ||
      envValue("AI_VIDEO_AGENT_VIDEO_MODEL", "BAILIAN_VIDEO_MODEL") ||
      DEFAULT_MODEL;
    const prompt = input.prompt.trim().slice(0, MAX_PROMPT_CHARS);
    const submittedAt = new Date().toISOString();
    let taskId = input.taskId?.trim() || "";
    let submitPayload: Record<string, unknown> | undefined;
    let raw: unknown = null;

    if (!taskId) {
      const submitted = await submitTextToVideo(input);
      taskId = submitted.taskId;
      submitPayload = submitted.payload;
      raw = submitted.raw;
    }

    if (input.poll === false) {
      return {
        ok: true,
        provider: "bailian",
        model,
        taskId,
        status: "PENDING",
        videoUrl: null,
        localPath: null,
        prompt,
        submitPayload,
        raw,
        warnings,
        submittedAt,
      };
    }

    const deadline = Date.now() + Math.max(30, input.maxWaitSeconds ?? 360) * 1000;
    let status: BailianVideoTaskStatus = "PENDING";
    let videoUrl: string | null = null;
    while (Date.now() < deadline) {
      const queried = await queryBailianVideoTask(taskId);
      raw = queried.raw;
      status = queried.status;
      videoUrl = queried.videoUrl;
      if (status === "SUCCEEDED" || status === "FAILED" || status === "CANCELED") {
        break;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS),
      );
    }

    if (status !== "SUCCEEDED" || !videoUrl) {
      warnings.push(
        status === "SUCCEEDED"
          ? "task_succeeded_without_video_url"
          : "task_not_completed_within_wait_window",
      );
      return {
        ok: false,
        provider: "bailian",
        model,
        taskId,
        status,
        videoUrl,
        localPath: null,
        prompt,
        submitPayload,
        raw,
        warnings,
        submittedAt,
      };
    }

    const localPath = await downloadVideo({
      url: videoUrl,
      outputDir: defaultOutputDir(input),
      fileName: input.outputFileName,
    });

    return {
      ok: true,
      provider: "bailian",
      model,
      taskId,
      status,
      videoUrl,
      localPath,
      prompt,
      submitPayload,
      raw,
      warnings,
      submittedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      provider: "bailian",
      model:
        input.model?.trim() ||
        envValue("AI_VIDEO_AGENT_VIDEO_MODEL", "BAILIAN_VIDEO_MODEL") ||
        DEFAULT_MODEL,
      taskId: input.taskId?.trim() || null,
      status: "FAILED",
      videoUrl: null,
      localPath: null,
      prompt: input.prompt.trim().slice(0, MAX_PROMPT_CHARS),
      error: error instanceof Error ? error.message : String(error),
      warnings,
    };
  }
}
