import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativePiWebChatToolDefinitions,
  createNativePiWebChatTools,
  getCurrentTimeSnapshot,
} from "@/lib/ai/native-pi-web-chat-tools";

describe("native Pi Web Chat tools", () => {
  it("advertises only fixed platform record source names for exact reads", () => {
    const tool = createNativePiWebChatToolDefinitions({ userId: "owner" }).find(candidate => candidate.name === "platformRecall");
    const sources = (tool?.parameters as any).properties.recordRead.properties.source.enum as string[];
    expect(sources).toContain("loopRuns");
    expect(sources).toContain("loopStates");
    expect(sources).not.toContain("runs");
  });
  it("binds platform statistics to original user time intent even when the model rewrites its query", async () => {
    const recall = vi.fn(async () => ({ ok: true, text: "{}" }));
    const args: Parameters<typeof createNativePiWebChatToolDefinitions> = [];
    args[0] = { userId: "u", question: "截至评测快照，记忆状态有多少条？" };
    args[22] = recall as never;
    const tool = createNativePiWebChatToolDefinitions(...args).find(t => t.name === "platformRecall");
    await tool?.execute({ question: "当前记忆各状态统计", sections: ["brain"] }, { toolCallId: "rewritten" });
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ requestedTimePolicy: expect.objectContaining({ mode: "unresolved" }) }));
  });
  it("binds snapshot reads to trusted Work identity rather than model arguments", async () => {
    const listSnapshots = vi.fn(async () => ({ ok: true, text: "{}" }));
    const tool = createNativePiWebChatToolDefinitions({ userId: "owner", memoryWorkId: "work-a", question: "original question" },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      listSnapshots as never).find(t => t.name === "brainListSnapshots");
    await tool?.execute({ snapshotId: "s", recordedBefore: "2026-01-01T00:00:00Z", offset: 0, workId: "work-b", originalQuestion: "rewritten question" } as never, { toolCallId: "snapshot" });
    expect(listSnapshots).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", workId: "work-a", originalQuestion: "original question", snapshotId: "s", offset: 0, recordedBefore: "2026-01-01T00:00:00Z" }));
  });
  it("prevents population statistics from using partial memory lists in any chat turn", async () => {
    const tools = createNativePiWebChatTools({ userId: "owner", question: "截至评测快照，记忆各状态有多少条？" });
    await expect(tools.find(tool => tool.name === "brainListMemories")!.execute("historical", { limit: 500 })).rejects.toThrow("Historical statistics");
    const current = createNativePiWebChatTools({ userId: "owner", question: "当前记忆各状态有多少条？" });
    await expect(current.find(tool => tool.name === "brainListMemories")!.execute("current", {})).rejects.toThrow("population counts");
  });
  it("exposes only allowed tools through self inspection and denies the gateway itself when restricted", async () => {
    const tools = createNativePiWebChatTools({ policy: { allowedTools: ["askMemory", "time", "webSearch"], deniedTools: ["webSearch"] } });
    const result = await tools.find(tool => tool.name === "askMemory")!.execute("self", { question: "my tools", domains: ["self"] });
    const output = JSON.parse((result.content[0] as { text: string }).text);
    expect(output.observations[0].availableTools.map((tool: any) => tool.name)).toEqual(["time", "askMemory"]);
    const denied = createNativePiWebChatTools({ policy: { allowedTools: ["time"], defaultDecision: "deny" } });
    await expect(denied.find(tool => tool.name === "askMemory")!.execute("self", { question: "q", domains: ["self"] })).rejects.toThrow("denied");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns a deterministic current time snapshot", () => {
    const snapshot = getCurrentTimeSnapshot({
      format: "iso",
      timezone: "Asia/Shanghai",
      now: () => new Date("2026-09-14T12:34:56.000Z"),
    });

    expect(snapshot).toMatchObject({
      success: true,
      currentTime: "2026-09-14T12:34:56.000Z",
      format: "iso",
      timestamp: Date.parse("2026-09-14T12:34:56.000Z"),
      timezone: "Asia/Shanghai",
      year: 2026,
      month: 9,
      date: 14,
      message:
        "Current time retrieved in iso format. IMPORTANT: The current year is 2026.",
    });
  });

  it("executes the Pi time tool through the guarded runtime policy", async () => {
    const onTrace = vi.fn();
    const [tool] = createNativePiWebChatTools({
      now: () => new Date("2026-09-14T12:34:56.000Z"),
      onTrace,
    });

    const result = await tool.execute(
      "tool-1",
      { format: "timestamp", timezone: "Asia/Shanghai" },
      undefined,
    );

    expect(result.details.result).toMatchObject({
      success: true,
      currentTime: Date.parse("2026-09-14T12:34:56.000Z").toString(),
      format: "timestamp",
      year: 2026,
      timezone: "Asia/Shanghai",
    });
    expect(result.details.trace.status).toBe("completed");
    expect(onTrace).toHaveBeenCalledWith(result.details.trace);
  });

  it("keeps approval-only tools denied by policy", async () => {
    const [tool] = createNativePiWebChatTools({
      policy: {
        requiresApprovalTools: ["time"],
      },
    });

    await expect(
      tool.execute("tool-approval", {}, undefined),
    ).rejects.toThrow("Tool requires owner approval.");
  });

  it("executes the Pi webSearch tool through the shared read-only adapter", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<html><body>
            <div class="result results_links">
              <a class="result__a" href="https://example.com/a">Example result</a>
              <a class="result__snippet">A citable snippet.</a>
            </div>
          </body></html>`,
          { status: 200 },
        ),
      ),
    );
    const tool = createNativePiWebChatTools().find(
      (candidate) => candidate.name === "webSearch",
    );

    const result = await tool?.execute(
      "tool-search",
      { query: "example", limit: 3 },
      undefined,
    );

    expect(result?.details.result).toMatchObject({
      success: true,
      query: "example",
      count: 1,
      results: [
        {
          title: "Example result",
          url: "https://example.com/a",
          snippet: "A citable snippet.",
          source: "duckduckgo",
        },
      ],
    });
    const firstContent = result?.content[0];
    expect(firstContent?.type).toBe("text");
    expect(firstContent && "text" in firstContent ? firstContent.text : "").toContain(
      "markdownSources",
    );
  });

  it("executes the Pi workshop manifest capabilities tool as read-only", async () => {
    const tool = createNativePiWebChatTools().find(
      (candidate) => candidate.name === "listWorkshopManifestCapabilities",
    );

    const result = await tool?.execute("tool-manifest", {}, undefined);

    expect(result?.details.result).toMatchObject({
      ok: true,
      manifestApiVersion: "openzhiyu.ai/v1alpha1",
      manifestKind: "Workshop",
    });
    const payload = result?.details.result as {
      tools?: Array<{ name: string }>;
      workflow?: string[];
    };
    expect(payload.tools?.some((item) => item.name === "webSearch")).toBe(
      true,
    );
    expect(payload.workflow?.join("\n")).toContain(
      "Only call applyWorkshopManifestYaml after the user explicitly confirms creation.",
    );
  });

  it("executes the Pi workshop manifest review tool as read-only", async () => {
    const reviewManifest = vi.fn(async () => ({
      manifest: { kind: "Workshop" },
      review: {
        ok: true,
        manifestName: "demo",
        title: "Demo",
        summary: {
          loops: 0,
          sources: 0,
          requestedTools: 0,
          requestedSkills: 0,
          deniedTools: 0,
        },
        issues: [],
        requestedTools: [],
        deniedTools: [],
        requestedSkills: [],
        creationReport: null,
      },
    }));
    const tool = createNativePiWebChatTools({
      userId: "user-1",
    }).find((candidate) => candidate.name === "reviewWorkshopManifestYaml");
    const manifestYaml = `
apiVersion: openzhiyu.ai/v1alpha1
kind: Workshop
metadata:
  name: demo
  title: Demo
spec:
  mission: Test
  role: Test
  control:
    object: demo
    objective: test
`;

    // Test the definition-level seam so the unit stays pure and does not read
    // the database-backed duplicate manifest checks.
    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      reviewManifest as never,
    ).find((candidate) => candidate.name === "reviewWorkshopManifestYaml");
    const result = await definition?.execute(
      { manifestYaml },
      { toolCallId: "tool-review" },
    );

    expect(reviewManifest).toHaveBeenCalledWith({
      userId: "user-1",
      manifestYaml,
    });
    expect(result).toMatchObject({
      review: {
        ok: true,
        manifestName: "demo",
      },
    });
    expect(tool?.name).toBe("reviewWorkshopManifestYaml");
  });

  it("executes the Pi workshop agent inspector as a read-only tool", async () => {
    const inspectWorkshopAgent = vi.fn(async () => ({
      ok: true,
      target: {
        id: "work-1",
        name: "自选股猎手",
      },
      work: {
        controlContract: {
          controlledObject: "watchlist",
        },
      },
      workshops: [
        {
          id: "work-1",
          name: "自选股猎手",
          status: "active",
          autonomyLevel: "draft",
        },
      ],
      instruction: "read the control contract before proposing changes",
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      inspectWorkshopAgent as never,
    ).find((candidate) => candidate.name === "inspectWorkshopAgent");
    const result = await definition?.execute(
      { workshopName: "自选股" },
      { toolCallId: "tool-inspect" },
    );

    expect(inspectWorkshopAgent).toHaveBeenCalledWith({
      userId: "user-1",
      workshopId: undefined,
      workshopName: "自选股",
    });
    expect(result).toMatchObject({
      ok: true,
      target: {
        id: "work-1",
      },
      work: {
        controlContract: {
          controlledObject: "watchlist",
        },
      },
    });
  });

  it("executes the Pi knowledge document list tool as metadata-only read", async () => {
    const listKnowledgeDocuments = vi.fn(async () => ({
      ok: true,
      text: "You have **1** document(s) in your knowledge base:\n\n1. **notes.md** (1 KB, 2 chunks, Sep 14, 2026)",
      documents: [
        {
          id: "doc-1",
          fileName: "notes.md",
          contentType: "text/markdown",
          sizeBytes: 1024,
          totalChunks: 2,
          uploadedAt: "2026-09-14T00:00:00.000Z",
        },
      ],
      count: 1,
      returnedCount: 1,
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      listKnowledgeDocuments as never,
    ).find((candidate) => candidate.name === "listKnowledgeBaseDocuments");
    const result = await definition?.execute(
      { limit: 999 },
      { toolCallId: "tool-documents" },
    );

    expect(listKnowledgeDocuments).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 100,
    });
    expect(result).toMatchObject({
      ok: true,
      documents: [
        {
          id: "doc-1",
          fileName: "notes.md",
        },
      ],
      count: 1,
    });
    expect(definition?.formatResult?.(result)).toContain("notes.md");
  });

  it("executes the Pi full document content tool through the owner-checked adapter", async () => {
    const getKnowledgeDocumentContent = vi.fn(async () => ({
      ok: true,
      text: "Full document body",
      data: {
        documentId: "doc-1",
        documentName: "notes.md",
        totalChunks: 2,
        contentLength: 18,
      },
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      getKnowledgeDocumentContent as never,
    ).find((candidate) => candidate.name === "getFullDocumentContent");
    const result = await definition?.execute(
      { documentId: "doc-1" },
      { toolCallId: "tool-document-content" },
    );

    expect(getKnowledgeDocumentContent).toHaveBeenCalledWith({
      userId: "user-1",
      documentId: "doc-1",
    });
    expect(result).toMatchObject({
      ok: true,
      text: "Full document body",
      data: {
        documentId: "doc-1",
        documentName: "notes.md",
      },
    });
    expect(definition?.formatResult?.(result)).toBe("Full document body");
    await definition?.execute({ documentId: "doc-1", offset: 8000, expectedHash: "a".repeat(64) }, { toolCallId: "tool-document-page" });
    expect(getKnowledgeDocumentContent).toHaveBeenLastCalledWith({ userId: "user-1", documentId: "doc-1", offset: 8000, expectedHash: "a".repeat(64) });
  });

  it("executes the Pi knowledge search tool through the shared semantic adapter", async () => {
    const searchKnowledge = vi.fn(async () => ({
      ok: true,
      text: "1. Matched chunk",
      data: {
        results: [
          {
            documentName: "notes.md",
            content: "Matched chunk",
            similarity: 0.91,
            chunkIndex: 0,
          },
        ],
        count: 1,
      },
    }));

    const definition = createNativePiWebChatToolDefinitions(
      {
        userId: "user-1",
        embeddingsAuthToken: "token-1",
      },
      undefined,
      undefined,
      undefined,
      undefined,
      searchKnowledge as never,
    ).find((candidate) => candidate.name === "searchKnowledgeBase");
    const result = await definition?.execute(
      {
        query: "migration",
        limit: 999,
        documentIds: ["doc-1", 42, "doc-2"],
      },
      { toolCallId: "tool-knowledge-search" },
    );

    expect(searchKnowledge).toHaveBeenCalledWith({
      userId: "user-1",
      query: "migration",
      limit: 20,
      documentIds: ["doc-1", "doc-2"],
      embeddingsAuthToken: "token-1",
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        count: 1,
      },
    });
    expect(definition?.formatResult?.(result)).toBe("1. Matched chunk");
  });

  it("executes the Pi unified memory search tool through the shared Brain-first adapter", async () => {
    const searchUnifiedMemory = vi.fn(async () => ({
      ok: true,
      text: "Brain-first memory recall for: zhiyu",
      data: {
        brainContext: null,
        legacyDiscovery: {
          count: 0,
        },
      },
    }));

    const definition = createNativePiWebChatToolDefinitions(
      {
        userId: "user-1",
        embeddingsAuthToken: "token-1",
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      searchUnifiedMemory as never,
    ).find((candidate) => candidate.name === "searchUnifiedMemory");
    const result = await definition?.execute(
      {
        query: "zhiyu",
        sources: ["memory", "knowledge", "invalid"],
        limit: 999,
        threshold: -9,
        documentIds: ["doc-1", 42],
        brainSourceKinds: ["wechat"],
        includeArchivedInsights: true,
      },
      { toolCallId: "tool-unified-memory" },
    );

    expect(searchUnifiedMemory).toHaveBeenCalledWith({
      userId: "user-1",
      query: "zhiyu",
      sources: ["memory", "knowledge"],
      limit: 20,
      threshold: -1,
      botIds: undefined,
      documentIds: ["doc-1"],
      includeArchivedInsights: true,
      brainSourceKinds: ["wechat"],
      brainPrivacyClasses: undefined,
      brainExcludePrivacyClasses: undefined,
      brainRiskLevels: undefined,
      brainScenarioKeys: undefined,
      embeddingsAuthToken: "token-1",
    });
    expect(result).toMatchObject({
      ok: true,
      text: "Brain-first memory recall for: zhiyu",
    });
    expect(definition?.formatResult?.(result)).toBe(
      "Brain-first memory recall for: zhiyu",
    );
  });

  it("executes the Pi memory path tool through the shared filesystem adapter", async () => {
    const searchMemoryPath = vi.fn(async () => ({
      ok: true,
      text: "Found memory files",
      data: {
        query: "project",
        matchCount: 1,
      },
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      searchMemoryPath as never,
    ).find((candidate) => candidate.name === "searchMemoryPath");
    const result = await definition?.execute(
      {
        query: "project",
        searchInFiles: false,
        directory: "projects",
      },
      { toolCallId: "tool-memory-path" },
    );

    expect(searchMemoryPath).toHaveBeenCalledWith({
      query: "project",
      searchInFiles: false,
      directory: "projects",
    });
    expect(result).toMatchObject({
      ok: true,
      text: "Found memory files",
    });
    expect(definition?.formatResult?.(result)).toBe("Found memory files");
  });

  it("executes the Pi chat insight tool through the shared read-only adapter", async () => {
    const queryChatInsights = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify(
        {
          success: true,
          insights: [{ id: "insight-1", title: "Project Alpha" }],
          pagination: {
            page: 1,
            pageSize: 5,
            totalCount: 1,
            totalPages: 1,
            hasMore: false,
            hasPrevious: false,
          },
        },
        null,
        2,
      ),
      data: {
        success: true,
        insights: [{ id: "insight-1", title: "Project Alpha" }],
      },
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      queryChatInsights as never,
    ).find((candidate) => candidate.name === "chatInsight");
    const result = await definition?.execute(
      {
        keyword: ["Project", "Alpha"],
        withDetail: true,
        searchMode: "basic",
        page: 1,
        pageSize: 5,
      },
      { toolCallId: "tool-chat-insight" },
    );

    expect(queryChatInsights).toHaveBeenCalledWith({
      userId: "user-1",
      withDetail: true,
      days: undefined,
      searchMode: "basic",
      keyword: ["Project", "Alpha"],
      insightIds: undefined,
      page: 1,
      pageSize: 5,
      filterDefinition: undefined,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        insights: [{ id: "insight-1", title: "Project Alpha" }],
      },
    });
    expect(definition?.formatResult?.(result)).toContain("Project Alpha");
  });

  it("executes the Pi contacts query tool through the shared read-only adapter", async () => {
    const queryContacts = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify(
        {
          success: true,
          contacts: [{ name: "Alice", type: "weixin" }],
          pagination: {
            page: 2,
            pageSize: 5,
            totalCount: 6,
            totalPages: 2,
            hasMore: false,
            hasPrevious: true,
          },
        },
        null,
        2,
      ),
      data: {
        success: true,
        contacts: [{ name: "Alice", type: "weixin" }],
      },
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      queryContacts as never,
    ).find((candidate) => candidate.name === "queryContacts");
    const result = await definition?.execute(
      {
        filter: { name: "Alice" },
        page: 2,
        pageSize: 5,
      },
      { toolCallId: "tool-contacts" },
    );

    expect(queryContacts).toHaveBeenCalledWith({
      userId: "user-1",
      filter: { name: "Alice" },
      page: 2,
      pageSize: 5,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        contacts: [{ name: "Alice", type: "weixin" }],
      },
    });
    expect(definition?.formatResult?.(result)).toContain("Alice");
  });

  it("executes the Pi Brain read tools through shared read-only adapters", async () => {
    const listBrainMemories = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify({ memories: [{ id: "memory-1" }] }),
      data: { memories: [{ id: "memory-1" }] },
    }));
    const listBrainCandidates = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify({ candidates: [{ id: "candidate-1" }] }),
      data: { candidates: [{ id: "candidate-1" }] },
    }));
    const listBrainSnapshots = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify({ snapshots: [{ id: "snapshot-1" }] }),
      data: { snapshots: [{ id: "snapshot-1" }] },
    }));
    const listBrainGrants = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify({ grants: [{ id: "grant-1" }] }),
      data: { grants: [{ id: "grant-1" }] },
    }));

    const definitions = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      listBrainMemories as never,
      listBrainCandidates as never,
      listBrainSnapshots as never,
      undefined,
      undefined,
      listBrainGrants as never,
    );

    const memories = await definitions
      .find((candidate) => candidate.name === "brainListMemories")
      ?.execute(
        {
          limit: 5,
          statuses: ["active"],
          memoryTypes: ["boundary"],
          ownerType: "work",
          ownerId: "work-1",
        },
        { toolCallId: "tool-brain-memories" },
      );
    const candidates = await definitions
      .find((candidate) => candidate.name === "brainListCandidates")
      ?.execute(
        {
          limit: 3,
          ownerType: "chat",
          ownerId: "chat-1",
        },
        { toolCallId: "tool-brain-candidates" },
      );
    const snapshots = await definitions
      .find((candidate) => candidate.name === "brainListSnapshots")
      ?.execute(
        {
          limit: 2,
          snapshotTypes: ["work_state"],
        },
        { toolCallId: "tool-brain-snapshots" },
      );
    const grants = await definitions
      .find((candidate) => candidate.name === "brainListGrants")
      ?.execute(
        {
          limit: 4,
          subjectType: "work",
          subjectId: "work-1",
        },
        { toolCallId: "tool-brain-grants" },
      );

    expect(listBrainMemories).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 5,
      statuses: ["active"],
      memoryTypes: ["boundary"],
      ownerType: "work",
      ownerId: "work-1",
    });
    expect(listBrainCandidates).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 3,
      ownerType: "chat",
      ownerId: "chat-1",
    });
    expect(listBrainSnapshots).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 2,
      snapshotTypes: ["work_state"],
    });
    expect(listBrainGrants).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 4,
      subjectType: "work",
      subjectId: "work-1",
    });
    expect(memories).toMatchObject({ data: { memories: [{ id: "memory-1" }] } });
    expect(candidates).toMatchObject({
      data: { candidates: [{ id: "candidate-1" }] },
    });
    expect(snapshots).toMatchObject({
      data: { snapshots: [{ id: "snapshot-1" }] },
    });
    expect(grants).toMatchObject({
      data: { grants: [{ id: "grant-1" }] },
    });
  });

  it("executes the Pi Loop task list tool through the shared read-only adapter", async () => {
    const listLoopTasks = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify({
        success: true,
        loops: [{ id: "loop-1", name: "Morning review" }],
      }),
      data: {
        success: true,
        loops: [{ id: "loop-1", name: "Morning review" }],
      },
      isError: false,
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      listLoopTasks as never,
    ).find((candidate) => candidate.name === "listLoopTasks");
    const result = await definition?.execute(
      {
        includeArchived: true,
        limit: 5,
      },
      { toolCallId: "tool-loop-list" },
    );

    expect(listLoopTasks).toHaveBeenCalledWith({
      userId: "user-1",
      includeArchived: true,
      limit: 5,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        loops: [{ id: "loop-1", name: "Morning review" }],
      },
    });
    expect(definition?.formatResult?.(result)).toContain("Morning review");
  });

  it("executes the Pi platform recall tool as a read-only aggregate", async () => {
    const platformRecall = vi.fn(async () => ({
      ok: true,
      question: "What can platform memory read?",
      sections: ["registry", "architecture"],
      registryVersion: "platform-information-registry-v1",
      generatedAt: "2026-09-19T00:00:00.000Z",
      warnings: [],
      data: {
        registry: [{ id: "architecture_contracts" }],
      },
      text: "platform recall result",
      isError: false,
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      platformRecall as never,
    ).find((candidate) => candidate.name === "platformRecall");
    const result = await definition?.execute(
      {
        question: "What can platform memory read?",
        sections: ["registry", "architecture"],
        limit: 10,
      },
      { toolCallId: "tool-platform-recall" },
    );

    expect(platformRecall).toHaveBeenCalledWith({
      runtimeCapabilities: expect.objectContaining({ toolNames: expect.arrayContaining(["askMemory", "platformRecall"]) }),
      userId: "user-1",
      question: "What can platform memory read?",
      sections: ["registry", "architecture"],
      limit: 10,
    });
    expect(result).toMatchObject({
      ok: true,
      registryVersion: "platform-information-registry-v1",
    });
    expect(definition?.formatResult?.(result)).toBe("platform recall result");
    await definition?.execute({ changeRead: { workshopId: "3153b95e-df02-4d31-9949-04f19e4eb8d4",
      beforeSeq: 100, limit: 5 } }, { toolCallId: "tool-platform-changes" });
    expect(platformRecall).toHaveBeenLastCalledWith(expect.objectContaining({
      userId: "user-1", changeRead: { workshopId: "3153b95e-df02-4d31-9949-04f19e4eb8d4",
        beforeSeq: 100, limit: 5 },
    }));
  });

  it("executes the Pi Loop task status tool through the shared owner-scoped control adapter", async () => {
    const setLoopStatus = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify({
        success: true,
        loop: {
          id: "loop-1",
          status: "paused",
        },
      }),
      data: {
        success: true,
        loop: {
          id: "loop-1",
          status: "paused",
        },
      },
      isError: false,
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      setLoopStatus as never,
    ).find((candidate) => candidate.name === "setLoopTaskStatus");
    const result = await definition?.execute(
      {
        loopId: " loop-1 ",
        status: "paused",
      },
      { toolCallId: "tool-loop-status" },
    );

    expect(setLoopStatus).toHaveBeenCalledWith({
      userId: "user-1",
      loopId: "loop-1",
      status: "paused",
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        loop: {
          id: "loop-1",
          status: "paused",
        },
      },
    });
    expect(definition?.formatResult?.(result)).toContain("paused");
  });

  it("executes the Pi WeChat desktop health tool through the shared read-only adapter", async () => {
    const getWechatHealth = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify({
        success: true,
        health: { ok: true, service: "wechat-desktop" },
      }),
      data: {
        success: true,
        health: { ok: true, service: "wechat-desktop" },
      },
      isError: false,
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      getWechatHealth as never,
    ).find((candidate) => candidate.name === "wechatDesktopHealth");
    const result = await definition?.execute(
      {},
      { toolCallId: "tool-wechat-health" },
    );

    expect(getWechatHealth).toHaveBeenCalledWith();
    expect(result).toMatchObject({
      ok: true,
      data: {
        health: { ok: true, service: "wechat-desktop" },
      },
    });
    expect(definition?.formatResult?.(result)).toContain("wechat-desktop");
  });

  it("executes the Pi WeChat desktop preview tool as an owner-reviewable action", async () => {
    const previewWechatMessage = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify({
        success: true,
        preview: {
          confirmToken: "confirm-1",
          recipientName: "Alice",
        },
        nextStep:
          "Ask the user to click the UI confirmation button. Do not call any send tool.",
      }),
      data: {
        success: true,
        preview: {
          confirmToken: "confirm-1",
          recipientName: "Alice",
        },
      },
      isError: false,
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      previewWechatMessage as never,
    ).find((candidate) => candidate.name === "wechatDesktopPreviewMessage");
    const result = await definition?.execute(
      {
        recipientName: " Alice ",
        message: "hello",
      },
      { toolCallId: "tool-wechat-preview" },
    );

    expect(previewWechatMessage).toHaveBeenCalledWith({
      recipientName: "Alice",
      message: "hello",
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        preview: {
          confirmToken: "confirm-1",
          recipientName: "Alice",
        },
      },
    });
    expect(definition?.formatResult?.(result)).toContain(
      "Do not call any send tool",
    );
  });

  it("creates an owner-reviewable workshop change proposal without applying it", async () => {
    const proposeAgentChange = vi.fn(async () => ({
      id: "event-1",
      title: "智能体修改提案：mission",
      metadata: {
        diff: [{ field: "mission", before: "old", after: "new" }],
        riskLevel: "medium",
      },
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      proposeAgentChange as never,
    ).find((candidate) => candidate.name === "proposeWorkshopAgentChange");
    const result = await definition?.execute(
      {
        workshopId: "workshop-1",
        reason: "narrow the mission",
        riskLevel: "medium",
        patch: {
          mission: "new mission",
          modelConfig: {
            primarySkills: ["writer"],
          },
          status: "invalid",
        },
      },
      { toolCallId: "tool-proposal" },
    );

    expect(proposeAgentChange).toHaveBeenCalledWith({
      userId: "user-1",
      workshopId: "workshop-1",
      patch: {
        mission: "new mission",
        modelConfig: {
          primarySkills: ["writer"],
        },
      },
      reason: "narrow the mission",
      riskLevel: "medium",
      proposedBy: "chat_agent",
      source: {
        surface: "web_chat_pi",
        tool: "proposeWorkshopAgentChange",
      },
    });
    expect(result).toMatchObject({
      ok: true,
      proposalEventId: "event-1",
      riskLevel: "medium",
    });
    expect(definition?.formatResult?.(result)).toContain(
      "Created a Workshop configuration proposal",
    );
  });

  it("creates an owner-reviewable Insight change proposal without applying it", async () => {
    const proposeInsightChange = vi.fn(async () => ({
      id: "insight-proposal-event-1",
      title: "Insight 创建提案：Prepare client demo",
      metadata: {
        action: "create",
        targetInsightId: null,
        riskLevel: "low",
      },
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      proposeInsightChange as never,
    ).find((candidate) => candidate.name === "proposeInsightChange");
    const result = await definition?.execute(
      {
        workshopId: "workshop-1",
        action: "create",
        title: " Prepare client demo ",
        reason: "capture durable context",
        requestedChange: {
          title: "Prepare client demo",
          description: "Prepare scenario-based product demo.",
        },
        riskLevel: "low",
      },
      { toolCallId: "tool-insight-proposal" },
    );

    expect(proposeInsightChange).toHaveBeenCalledWith({
      userId: "user-1",
      workshopId: "workshop-1",
      action: "create",
      reason: "capture durable context",
      title: "Prepare client demo",
      targetInsightId: undefined,
      requestedChange: {
        title: "Prepare client demo",
        description: "Prepare scenario-based product demo.",
      },
      riskLevel: "low",
      proposedBy: "chat_agent",
      source: {
        surface: "web_chat_pi",
        tool: "proposeInsightChange",
      },
    });
    expect(result).toMatchObject({
      ok: true,
      proposalEventId: "insight-proposal-event-1",
      action: "create",
      riskLevel: "low",
    });
    expect(definition?.formatResult?.(result)).toContain(
      "Created an Insight change proposal",
    );
  });

  it("creates an owner-reviewable paused Loop task proposal without starting it", async () => {
    const proposeLoopTask = vi.fn(async () => ({
      loop: {
        id: "loop-1",
        name: "Daily market scan",
        status: "paused",
        goal: "Scan watchlist every trading morning",
      },
      draft: {
        name: "Daily market scan",
        spec: {
          goal: "Scan watchlist every trading morning",
        },
      },
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      proposeLoopTask as never,
    ).find((candidate) => candidate.name === "proposeWorkshopLoopTask");
    const result = await definition?.execute(
      {
        workshopId: "workshop-1",
        intent: "Every trading day before open, scan my watchlist.",
        timezone: "Asia/Shanghai",
        reason: "durable market monitoring",
      },
      { toolCallId: "tool-loop-proposal" },
    );

    expect(proposeLoopTask).toHaveBeenCalledWith({
      userId: "user-1",
      workshopId: "workshop-1",
      intent: "Every trading day before open, scan my watchlist.",
      timezone: "Asia/Shanghai",
      proposedBy: "workshop_agent",
      proposalReason: "durable market monitoring",
      commandId: expect.stringMatching(/^web-chat-pi-loop-proposal:[0-9a-f]{48}$/),
    });
    expect(result).toMatchObject({
      ok: true,
      message:
        "Created a paused Loop task proposal. The owner must review and activate it in the Workshop UI before it can run.",
      loopId: "loop-1",
      status: "paused",
      name: "Daily market scan",
    });
    expect(definition?.formatResult?.(result)).toContain(
      "Created a paused Loop task proposal",
    );
  });

  it("creates an owner-reviewable Loop change proposal without applying it", async () => {
    const proposeLoopChange = vi.fn(async () => ({
      id: "loop-change-event-1",
      title: "Loop change proposed: Daily market scan",
      metadata: {
        changedFields: ["triggerConfig"],
        riskLevel: "medium",
      },
    }));

    const definition = createNativePiWebChatToolDefinitions(
      { userId: "user-1" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      proposeLoopChange as never,
    ).find((candidate) => candidate.name === "proposeWorkshopLoopChange");
    const result = await definition?.execute(
      {
        workshopId: "workshop-1",
        loopId: "loop-1",
        action: "update",
        reason: "owner should review schedule change",
        riskLevel: "medium",
        patch: {
          triggerConfig: {
            type: "cron",
            expression: "30 10 * * 1-5",
            timezone: "Asia/Shanghai",
          },
        },
      },
      { toolCallId: "tool-loop-change" },
    );

    expect(proposeLoopChange).toHaveBeenCalledWith({
      userId: "user-1",
      workshopId: "workshop-1",
      loopId: "loop-1",
      action: "update",
      reason: "owner should review schedule change",
      riskLevel: "medium",
      patch: {
        triggerConfig: {
          type: "cron",
          expression: "30 10 * * 1-5",
          timezone: "Asia/Shanghai",
        },
      },
      proposedBy: "chat_agent",
      source: expect.objectContaining({
        surface: "web_chat_pi",
        tool: "proposeWorkshopLoopChange",
        proposalKey: expect.stringMatching(
          /^web-chat-pi-loop-change-proposal:[0-9a-f]{48}$/,
        ),
      }),
    });
    expect(result).toMatchObject({
      ok: true,
      message:
        "Created a Loop change proposal. The owner must review it in the Workshop review queue before the Loop changes.",
      proposalEventId: "loop-change-event-1",
      workshopId: "workshop-1",
      loopId: "loop-1",
      action: "update",
      changedFields: ["triggerConfig"],
      riskLevel: "medium",
    });
  });
});
