import {
  ModelConfigurationError,
  normalizeModelBaseUrl,
} from "@openzhiyu/shared/model-configuration";
import { MediaServiceError, readLimited } from "@openzhiyu/ai/audio";
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

function valueFrom(
  env: Record<string, string | undefined>,
  ...names: string[]
) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (/^\$[A-Z0-9_]+$/i.test(value)) {
      const referenced = env[value.slice(1)]?.trim();
      if (referenced) return referenced;
      continue;
    }
    return value;
  }
  return undefined;
}

function envValue(...names: string[]) {
  return valueFrom(process.env, ...names);
}

function getApiKey(env: Record<string, string | undefined> = process.env) {
  const dedicated = valueFrom(
    env,
    "AI_VIDEO_AGENT_VIDEO_API_KEY",
    "AI_VIDEO_AGENT_WAN_API_KEY",
    "BAILIAN_VIDEO_API_KEY",
  );
  if (dedicated) return dedicated;
  // Text-planner credentials are not a video connection. Shared Alibaba keys
  // may only be sent to Alibaba endpoints, never an unrelated custom host.
  const hosts = [getExplicitEndpoint(env), getBaseUrl(env)]
    .filter((value): value is string => Boolean(value))
    .map((value) => new URL(value).hostname);
  if (hosts.every((host) => host.endsWith(".aliyuncs.com")))
    return valueFrom(env, "DASHSCOPE_API_KEY", "BAILIAN_API_KEY");
  throw new ModelConfigurationError("model_config_incomplete", "video");
}

function getExplicitEndpoint(
  env: Record<string, string | undefined> = process.env,
) {
  return valueFrom(
    env,
    "AI_VIDEO_AGENT_VIDEO_ENDPOINT",
    "AI_VIDEO_AGENT_WAN_ENDPOINT",
    "DASHSCOPE_VIDEO_ENDPOINT",
    "BAILIAN_VIDEO_ENDPOINT",
  );
}

function getRegion(env: Record<string, string | undefined> = process.env) {
  return (
    valueFrom(
      env,
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

function getBaseUrl(env: Record<string, string | undefined> = process.env) {
  const raw = valueFrom(
    env,
    "AI_VIDEO_AGENT_VIDEO_BASE_URL",
    "AI_VIDEO_AGENT_WAN_BASE_URL",
    "BAILIAN_VIDEO_BASE_URL",
    "DASHSCOPE_VIDEO_BASE_URL",
  );
  if (raw) return raw.replace(/\/+$/g, "");
  const workspaceId = getWorkspaceId(env);
  const region = getRegion(env);
  if (workspaceId) {
    return `https://${workspaceId}.${getRegionHost(region)}/api/v1`;
  }
  const publicHost = getPublicRegionHost(region);
  if (publicHost) return `https://${publicHost}/api/v1`;
  return DEFAULT_BASE_URL;
}

function getWorkspaceId(env: Record<string, string | undefined> = process.env) {
  return valueFrom(
    env,
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

export type BailianVideoConnection = {
  apiKey: string;
  baseUrl: string;
  endpoint?: string;
  model: string;
};
export function resolveBailianVideoConnection(
  env: Record<string, string | undefined> = process.env,
): BailianVideoConnection {
  const baseUrl = normalizeModelBaseUrl(getBaseUrl(env), "video");
  const endpoint = getExplicitEndpoint(env);
  if (endpoint) normalizeModelBaseUrl(endpoint, "video");
  return {
    baseUrl,
    endpoint,
    apiKey: getApiKey(env) || "",
    model:
      valueFrom(env, "AI_VIDEO_AGENT_VIDEO_MODEL", "BAILIAN_VIDEO_MODEL") ||
      DEFAULT_MODEL,
  };
}
function createEndpoint(connection: BailianVideoConnection) {
  return (
    connection.endpoint ||
    connection.baseUrl + "/services/aigc/video-generation/video-synthesis"
  );
}
function taskEndpoint(id: string, connection: BailianVideoConnection) {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(id))
    throw new MediaServiceError("video_task_id_invalid");
  const endpoint = connection.endpoint,
    index = endpoint?.indexOf("/api/v1/") ?? -1;
  return endpoint && index !== -1
    ? endpoint.slice(0, index + 8) + "tasks/" + id
    : connection.baseUrl + "/tasks/" + id;
}

async function fetchJson(input: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(input, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal,
      redirect: "error",
      headers: {
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaServiceError("video_provider_http_error", response.status);
    }
    const text = new TextDecoder().decode(
      await readLimited(response, 1024 * 1024),
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new MediaServiceError("video_response_invalid");
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

export async function submitBailianVideoTask(
  input: BailianVideoGenerateInput,
  connection = resolveBailianVideoConnection(),
  signal?: AbortSignal,
) {
  const apiKey = connection.apiKey;
  if (!apiKey) {
    throw new Error(
      "Missing Bailian video API key. Set BAILIAN_VIDEO_API_KEY, DASHSCOPE_API_KEY, or BAILIAN_API_KEY.",
    );
  }

  const model = input.model?.trim() || connection.model;
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

  const raw = await fetchJson(createEndpoint(connection), {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify(payload),
  });
  const taskId = findTaskId(raw);
  if (!taskId) {
    throw new Error("Bailian video task response did not include task_id.");
  }
  return { raw, taskId, model, prompt, payload };
}

export async function queryBailianVideoTask(
  taskId: string,
  connection = resolveBailianVideoConnection(),
  signal?: AbortSignal,
) {
  const apiKey = connection.apiKey;
  if (!apiKey) {
    throw new Error(
      "Missing Bailian video API key. Set BAILIAN_VIDEO_API_KEY, DASHSCOPE_API_KEY, or BAILIAN_API_KEY.",
    );
  }
  const raw = await fetchJson(taskEndpoint(taskId, connection), {
    signal,
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
  let connection: BailianVideoConnection | undefined;
  try {
    connection = resolveBailianVideoConnection();
    const model = input.model?.trim() || connection.model;
    const prompt = input.prompt.trim().slice(0, MAX_PROMPT_CHARS);
    const submittedAt = new Date().toISOString();
    let taskId = input.taskId?.trim() || "";
    let submitPayload: Record<string, unknown> | undefined;
    let raw: unknown = null;

    if (!taskId) {
      const submitted = await submitBailianVideoTask(input, connection);
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

    const deadline =
      Date.now() + Math.max(30, input.maxWaitSeconds ?? 360) * 1000;
    let status: BailianVideoTaskStatus = "PENDING";
    let videoUrl: string | null = null;
    while (Date.now() < deadline) {
      const queried = await queryBailianVideoTask(taskId, connection);
      raw = queried.raw;
      status = queried.status;
      videoUrl = queried.videoUrl;
      if (
        status === "SUCCEEDED" ||
        status === "FAILED" ||
        status === "CANCELED"
      ) {
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
