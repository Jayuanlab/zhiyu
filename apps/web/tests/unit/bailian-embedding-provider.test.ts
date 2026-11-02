import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudEmbeddingProvider } from "../../../../packages/ai/rag/src/embedding-provider";

const ORIGINAL_ENV = { ...process.env };

function installEmbeddingFetchMock() {
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      input?: string | string[];
    };
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];

    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        data: inputs.map((_input, index) => ({
          index,
          embedding: [index + 0.1, index + 0.2, index + 0.3],
        })),
      }),
    };
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Bailian embedding provider", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OPENAI_EMBEDDINGS_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.BAILIAN_API_KEY;
    delete process.env.ALIBABA_CLOUD_API_KEY;
    delete process.env.LLM_EMBEDDING_BASE_URL;
    delete process.env.LLM_EMBEDDING_MODEL;
    delete process.env.LLM_EMBEDDING_DIMENSIONS;
    delete process.env.LLM_EMBEDDING_BATCH_SIZE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses text-embedding-v4 on the Bailian OpenAI-compatible endpoint", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-test";
    const fetchMock = installEmbeddingFetchMock();

    const provider = new CloudEmbeddingProvider();
    const embedding = await provider.embedQuery("owner memory");

    expect(provider.getModelName()).toBe("text-embedding-v4");
    expect(provider.getDimensions()).toBe(3);
    expect(embedding).toEqual([0.1, 0.2, 0.3]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "text-embedding-v4",
      input: "owner memory",
      encoding_format: "float",
      dimensions: 1024,
    });
  });

  it("resolves local env references and ignores placeholder keys", async () => {
    process.env.OPENAI_EMBEDDINGS_API_KEY = "****";
    process.env.ANTHROPIC_API_KEY = "sk-bailian";
    process.env.DASHSCOPE_API_KEY = "$ANTHROPIC_API_KEY";
    process.env.LLM_EMBEDDING_BASE_URL =
      "https://dashscope.aliyuncs.com/compatible-mode";
    const fetchMock = installEmbeddingFetchMock();

    const provider = new CloudEmbeddingProvider();
    await provider.embedQuery("referenced key");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-bailian",
    );
  });

  it("caps text-embedding-v4 batches at ten inputs", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-test";
    process.env.LLM_EMBEDDING_BATCH_SIZE = "99";
    const fetchMock = installEmbeddingFetchMock();

    const provider = new CloudEmbeddingProvider();
    await provider.embedDocuments(
      Array.from({ length: 11 }, (_item, index) => `text ${index}`),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      input: string[];
    };
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as {
      input: string;
    };
    expect(firstBody.input).toHaveLength(10);
    expect(secondBody.input).toBe("text 10");
  });

  it("does not send a text-provider key or user token to an unrelated embedding host", async () => {
    process.env.LLM_BASE_URL = "https://text.invalid/v1";
    process.env.LLM_API_KEY = "text-secret";
    process.env.LLM_EMBEDDING_BASE_URL = "https://embedding.invalid/v1";
    const fetchMock = installEmbeddingFetchMock();
    const provider = new CloudEmbeddingProvider({ userAuthToken: "user-jwt" });
    await expect(provider.embedQuery("private memory")).rejects.toThrow("model_config_incomplete: embedding");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("permits an explicit embedding credential without inheriting a text model", async () => {
    process.env.LLM_BASE_URL = "https://text.invalid/v1";
    process.env.LLM_API_KEY = "text-secret";
    process.env.LLM_MODEL = "text-model";
    process.env.LLM_EMBEDDING_BASE_URL = "https://embedding.invalid/v1";
    process.env.OPENAI_EMBEDDINGS_API_KEY = "embedding-secret";
    process.env.LLM_EMBEDDING_MODEL = "embedding-model";
    const fetchMock = installEmbeddingFetchMock();
    await new CloudEmbeddingProvider().embedQuery("memory");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://embedding.invalid/v1/embeddings");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer embedding-secret");
    expect(JSON.parse(String(init?.body)).model).toBe("embedding-model");
  });
});
