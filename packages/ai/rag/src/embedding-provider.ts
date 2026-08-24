/**
 * Shared embedding provider abstraction.
 *
 * The app should depend on this interface instead of coupling directly to a
 * specific cloud API or local model runtime.
 */

import { ProxyAgent } from "undici";
import { LocalTransformersEmbeddingProvider } from "./local-transformers-embedding-provider";

const DEFAULT_CLOUD_EMBEDDING_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_CLOUD_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_BAILIAN_EMBEDDING_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_BAILIAN_EMBEDDING_MODEL = "text-embedding-v4";
const DEFAULT_EMBEDDING_BATCH_SIZE = 10;
const DASHSCOPE_NATIVE_EMBEDDING_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding";

export type EmbeddingApiFormat = "openai" | "dashscope";

export type EmbeddingProviderType = "cloud" | "local";

export interface EmbeddingProvider {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  getModelName(): string;
  getDimensions(): number | undefined;
}

export interface EmbeddingProviderFactoryOptions {
  userAuthToken?: string;
}

export interface CloudEmbeddingProviderOptions extends EmbeddingProviderFactoryOptions {
  apiKey?: string;
  baseURL?: string;
  modelName?: string;
  batchSize?: number;
}

export function getConfiguredEmbeddingProvider(
  options: EmbeddingProviderFactoryOptions = {},
): EmbeddingProvider {
  const provider = getEmbeddingProviderType();

  if (provider === "local") {
    return new LocalTransformersEmbeddingProvider();
  }

  return new CloudEmbeddingProvider(options);
}

export function getConfiguredEmbeddingModelName(): string {
  if (getEmbeddingProviderType() === "local") {
    return (
      getConfiguredEnvValue("LOCAL_EMBEDDING_MODEL") ||
      "Xenova/all-MiniLM-L6-v2"
    ).trim();
  }

  return (
    getConfiguredEnvValue("LLM_EMBEDDING_MODEL") ||
    (hasBailianEmbeddingConfig()
      ? DEFAULT_BAILIAN_EMBEDDING_MODEL
      : DEFAULT_CLOUD_EMBEDDING_MODEL)
  ).trim();
}

export function getEmbeddingProviderType(): EmbeddingProviderType {
  const provider = (process.env.EMBEDDING_PROVIDER || "cloud")
    .trim()
    .toLowerCase();

  return provider === "local" ? "local" : "cloud";
}

export class CloudEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string;
  private modelName: string;
  private baseURL: string;
  private apiFormat: EmbeddingApiFormat;
  private userAuthToken?: string;
  private batchSize: number;
  private configuredDimensions?: number;
  private dimensions?: number;

  constructor(options: CloudEmbeddingProviderOptions = {}) {
    this.apiKey =
      options.apiKey ||
      getConfiguredEnvValue("OPENAI_EMBEDDINGS_API_KEY") ||
      getConfiguredEnvValue("DASHSCOPE_API_KEY") ||
      getConfiguredEnvValue("BAILIAN_API_KEY") ||
      getConfiguredEnvValue("ALIBABA_CLOUD_API_KEY") ||
      getConfiguredEnvValue("OPENROUTER_API_KEY") ||
      getConfiguredEnvValue("LLM_API_KEY") ||
      "";

    this.userAuthToken = options.userAuthToken;
    this.modelName = options.modelName || getConfiguredEmbeddingModelName();
    const configuredBaseURL =
      options.baseURL ||
      getConfiguredEnvValue("LLM_EMBEDDING_BASE_URL") ||
      (isBailianEmbeddingModel(this.modelName) || hasBailianEmbeddingConfig()
        ? DEFAULT_BAILIAN_EMBEDDING_BASE_URL
        : getConfiguredEnvValue("LLM_BASE_URL") ||
          DEFAULT_CLOUD_EMBEDDING_BASE_URL);
    this.baseURL = normalizeEmbeddingBaseURL(configuredBaseURL, this.modelName);
    this.apiFormat = resolveEmbeddingApiFormat(this.modelName);
    if (
      this.apiFormat === "dashscope" &&
      this.baseURL.includes("compatible-mode")
    ) {
      this.baseURL = DASHSCOPE_NATIVE_EMBEDDING_URL;
    }
    this.configuredDimensions = getConfiguredEmbeddingDimensions(
      this.modelName,
    );
    this.dimensions = this.configuredDimensions;
    this.batchSize = Math.min(
      options.batchSize ?? getEmbeddingBatchSize(),
      getEmbeddingMaxBatchSize(this.modelName),
    );
  }

  getModelName(): string {
    return this.modelName;
  }

  getDimensions(): number | undefined {
    return this.dimensions;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      throw new Error("No texts provided for embedding");
    }

    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchEmbeddings = await this.callEmbeddingAPI(batch);
      results.push(...batchEmbeddings);
    }

    return results;
  }

  async embedQuery(text: string): Promise<number[]> {
    const embeddings = await this.callEmbeddingAPI([text]);
    return embeddings[0];
  }

  private async callEmbeddingAPI(texts: string[]): Promise<number[][]> {
    console.log("[RAG] Calling embeddings API:", {
      provider: "cloud",
      apiFormat: this.apiFormat,
      baseURL: this.baseURL,
      model: this.modelName,
      textCount: texts.length,
      hasApiKey: !!this.apiKey,
      hasUserAuthToken: !!this.userAuthToken,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;

      if (this.baseURL.includes("openrouter.ai")) {
        headers["HTTP-Referer"] =
          getConfiguredEnvValue("NEXT_PUBLIC_APP_URL") ||
          "https://openzhiyu.ai";
        headers["X-Title"] = "Zhiyu AI";
      }
    } else if (this.userAuthToken) {
      headers.Authorization = `Bearer ${this.userAuthToken}`;
    } else {
      console.warn(
        `[RAG] No auth token available for embeddings API. This may cause request failures or use default rate limits. baseURL=${this.baseURL}, hasApiKey=${!!this.apiKey}`,
      );
    }

    const requestUrl =
      this.apiFormat === "dashscope"
        ? this.baseURL
        : `${this.baseURL.replace(/\/$/, "")}/embeddings`;
    const requestBody =
      this.apiFormat === "dashscope"
        ? {
            model: this.modelName,
            input: { texts },
            parameters: {
              ...(this.configuredDimensions
                ? { dimension: this.configuredDimensions }
                : {}),
              ...(process.env.LLM_EMBEDDING_TEXT_TYPE
                ? {
                    text_type: getConfiguredEnvValue("LLM_EMBEDDING_TEXT_TYPE"),
                  }
                : {}),
              ...(process.env.LLM_EMBEDDING_OUTPUT_TYPE
                ? {
                    output_type: getConfiguredEnvValue(
                      "LLM_EMBEDDING_OUTPUT_TYPE",
                    ),
                  }
                : {}),
              ...(process.env.LLM_EMBEDDING_INSTRUCT
                ? {
                    instruct: getConfiguredEnvValue("LLM_EMBEDDING_INSTRUCT"),
                  }
                : {}),
            },
          }
        : {
            model: this.modelName,
            input: texts.length === 1 ? texts[0] : texts,
            encoding_format: "float",
            ...(this.configuredDimensions
              ? { dimensions: this.configuredDimensions }
              : {}),
          };

    const response = await fetch(requestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      ...getFetchProxyOptions(requestUrl),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const errorMessage = `Embeddings API error (${response.status}): ${errorText}`;
      throw new Error(errorMessage);
    }

    const data = await response.json();
    const embeddings = parseEmbeddingResponse(data, this.apiFormat);

    this.dimensions = embeddings[0]?.length ?? this.dimensions;
    return embeddings;
  }
}

let cachedProxyAgent:
  | {
      proxyUrl: string;
      agent: ProxyAgent;
    }
  | undefined;

function getFetchProxyOptions(
  requestUrl: string,
): Record<string, unknown> | undefined {
  const proxyUrl = getProxyUrlForRequest(requestUrl);
  if (!proxyUrl) return undefined;

  if (cachedProxyAgent?.proxyUrl !== proxyUrl) {
    cachedProxyAgent = {
      proxyUrl,
      agent: new ProxyAgent(proxyUrl),
    };
  }

  return { dispatcher: cachedProxyAgent.agent };
}

function getProxyUrlForRequest(requestUrl: string): string | undefined {
  let hostname: string;
  try {
    hostname = new URL(requestUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }

  if (isNoProxyHost(hostname)) return undefined;

  return (
    getConfiguredEnvValue("HTTPS_PROXY") ||
    getConfiguredEnvValue("HTTP_PROXY") ||
    getConfiguredEnvValue("ALL_PROXY")
  );
}

function isNoProxyHost(hostname: string): boolean {
  const raw = getConfiguredEnvValue("NO_PROXY");
  if (!raw) return false;

  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((pattern) => {
      if (pattern === "*") return true;
      if (pattern.startsWith(".")) {
        return hostname === pattern.slice(1) || hostname.endsWith(pattern);
      }
      return hostname === pattern || hostname.endsWith(`.${pattern}`);
    });
}

function resolveEmbeddingApiFormat(modelName: string): EmbeddingApiFormat {
  const configured = (process.env.LLM_EMBEDDING_API_FORMAT || "")
    .trim()
    .toLowerCase();
  if (configured === "dashscope") return "dashscope";
  if (configured === "openai") return "openai";
  if (/^bge-/i.test(modelName.trim())) return "dashscope";
  return "openai";
}

function hasBailianEmbeddingConfig(): boolean {
  return Boolean(
    getConfiguredEnvValue("DASHSCOPE_API_KEY") ||
    getConfiguredEnvValue("BAILIAN_API_KEY") ||
    getConfiguredEnvValue("ALIBABA_CLOUD_API_KEY"),
  );
}

function isBailianEmbeddingModel(modelName: string): boolean {
  return /^(text-embedding-v\d+|qwen\d*(?:\.\d+)?-text-embedding|bge-)/i.test(
    modelName.trim(),
  );
}

function normalizeEmbeddingBaseURL(baseURL: string, modelName: string): string {
  const trimmed = baseURL.trim().replace(/\/$/, "");
  if (!trimmed) {
    return isBailianEmbeddingModel(modelName)
      ? DEFAULT_BAILIAN_EMBEDDING_BASE_URL
      : DEFAULT_CLOUD_EMBEDDING_BASE_URL;
  }
  if (trimmed === "https://dashscope.aliyuncs.com/compatible-mode") {
    return DEFAULT_BAILIAN_EMBEDDING_BASE_URL;
  }
  if (trimmed === "https://dashscope.aliyuncs.com") {
    return DEFAULT_BAILIAN_EMBEDDING_BASE_URL;
  }
  return trimmed;
}

function getConfiguredEmbeddingDimensions(
  modelName: string,
): number | undefined {
  const configured = getConfiguredEnvValue("LLM_EMBEDDING_DIMENSIONS");
  if (configured) {
    const parsed = Number.parseInt(configured, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    console.warn(
      `[RAG] Invalid LLM_EMBEDDING_DIMENSIONS=${configured}; using model default.`,
    );
  }
  if (/^text-embedding-v4$/i.test(modelName.trim())) {
    return 1024;
  }
  return undefined;
}

function getEmbeddingMaxBatchSize(modelName: string): number {
  if (/^text-embedding-v4$/i.test(modelName.trim())) return 10;
  return Number.POSITIVE_INFINITY;
}

function parseEmbeddingResponse(
  data: Record<string, unknown>,
  apiFormat: EmbeddingApiFormat,
): number[][] {
  if (apiFormat === "dashscope") {
    const output =
      data.output && typeof data.output === "object"
        ? (data.output as Record<string, unknown>)
        : null;
    const items = output?.embeddings;
    if (!Array.isArray(items)) {
      throw new Error(
        "Invalid DashScope embedding response. Expected output.embeddings array.",
      );
    }
    return items.map((item, index) => {
      if (
        !item ||
        typeof item !== "object" ||
        !Array.isArray((item as { embedding?: unknown }).embedding)
      ) {
        throw new Error(`Invalid DashScope embedding at index ${index}`);
      }
      return (item as { embedding: number[] }).embedding;
    });
  }

  if (!data.data || !Array.isArray(data.data)) {
    throw new Error(
      "Invalid response format from embeddings API. Expected data.data array.",
    );
  }

  const sortedData = [...data.data].sort(
    (a: { index?: number }, b: { index?: number }) =>
      (a.index ?? 0) - (b.index ?? 0),
  );
  return sortedData.map((item: { embedding?: number[] }, index: number) => {
    if (!item.embedding || !Array.isArray(item.embedding)) {
      throw new Error(`Invalid embedding format in response at index ${index}`);
    }
    return item.embedding;
  });
}

function getEmbeddingBatchSize(): number {
  const rawBatchSize = getConfiguredEnvValue("LLM_EMBEDDING_BATCH_SIZE");
  if (!rawBatchSize) return DEFAULT_EMBEDDING_BATCH_SIZE;

  const parsedBatchSize = Number(rawBatchSize);
  if (!Number.isFinite(parsedBatchSize) || parsedBatchSize < 1) {
    console.warn(
      `[RAG] Invalid LLM_EMBEDDING_BATCH_SIZE=${rawBatchSize}; using ${DEFAULT_EMBEDDING_BATCH_SIZE}`,
    );
    return DEFAULT_EMBEDDING_BATCH_SIZE;
  }

  return Math.floor(parsedBatchSize);
}

function getConfiguredEnvValue(
  key: string,
  visited = new Set<string>(),
): string | undefined {
  if (visited.has(key)) return undefined;
  visited.add(key);

  const raw = process.env[key];
  if (!raw) return undefined;

  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed === "****" ||
    trimmed.toLowerCase() === "undefined" ||
    trimmed.toLowerCase() === "null"
  ) {
    return undefined;
  }

  if (/^\$[A-Z0-9_]+$/i.test(trimmed)) {
    return getConfiguredEnvValue(trimmed.slice(1), visited);
  }

  return trimmed;
}
