import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const owner = "11111111-1111-4111-8111-111111111111";
const chatId = "22222222-2222-4222-8222-222222222222";
const assistantMessageId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const loopId = "55555555-5555-4555-8555-555555555555";
const mocks = vi.hoisted(() => ({ reserve: vi.fn(), append: vi.fn(), create: vi.fn(), finalize: vi.fn(), createSession: vi.fn(), tools: vi.fn(), authorizeRecords: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: async () => ({ user: { id: "11111111-1111-4111-8111-111111111111" } }) }));
vi.mock("@openzhiyu/ai/agent/registry", () => ({ getAgentRegistry: () => ({ register: vi.fn(), create: mocks.create }) }));
vi.mock("@/lib/ai/extensions", () => ({ claudePlugin: { name: "claude" }, piPlugin: { name: "pi" } }));
vi.mock("@/lib/db/client", () => ({ db: {}, withDatabaseTransaction: vi.fn() }));
vi.mock("@/lib/db/chat-queries", () => ({ getMessagesByChatId: async () => [] }));
vi.mock("@/lib/work-runtime/chat-work-items", async original => ({
  ...await original<typeof import("@/lib/work-runtime/chat-work-items")>(), readChatWorkshopContext: async () => null,
}));
vi.mock("@/lib/db/insight-queries", () => ({ getUserInsightSettings: async () => ({ language: "en" }) }));
vi.mock("@/lib/ai/user-llm-api-settings", () => ({ getUserLlmProviderConfig: async () => undefined }));
vi.mock("@/lib/ai/native-pi-user-config", () => ({ resolveNativePiUserConfig: () => ({ apiKey: "fake", baseUrl: "https://synthetic.invalid", model: "fake-model", protocol: "anthropic" }) }));
vi.mock("@/lib/loops", () => ({ resolveChatLoopGuardContext: async () => null, withNativeAgentLoopGuardMetadata: ({ request }: any) => request }));
vi.mock("@/lib/loops/service", () => ({ getLoop: async () => ({ id: "55555555-5555-4555-8555-555555555555" }) }));
vi.mock("@/lib/ai/skills/loader", () => ({ loadSkills: () => [], getSkillContent: () => null }));
vi.mock("@/lib/ai/native-pi-web-chat-tools", async original => ({ ...await original<typeof import("@/lib/ai/native-pi-web-chat-tools")>(), NATIVE_PI_WEB_CHAT_TOOLS: [], createNativePiWebChatTools: mocks.tools }));
vi.mock("@/lib/ai/platform-record-reader", async original => ({ ...await original<typeof import("@/lib/ai/platform-record-reader")>(), authorizePlatformPublishedRecordsForOwner: mocks.authorizeRecords }));
vi.mock("@/lib/ai/jev-platform-prefetch", () => ({ prefetchPlatformWithJev: async function* ({ prompt }: { prompt: string }) { return prompt; } }));
vi.mock("@/lib/db/agent-answer-audits", async (original) => ({ ...await original<typeof import("@/lib/db/agent-answer-audits")>(), reserveAgentAnswerTurn: mocks.reserve, appendAgentAnswerAuditEvent: mocks.append }));
vi.mock("@/lib/ai/runtime/answer-evidence-session", async (original) => ({ ...await original<typeof import("@/lib/ai/runtime/answer-evidence-session")>(), ANSWER_EVIDENCE_RULE_VERSION: "test-rule", createAnswerEvidenceSession: mocks.createSession }));
vi.mock("@/lib/ai/runtime/answer-evidence-loop-gate", async original => ({ ...await original<typeof import("@/lib/ai/runtime/answer-evidence-loop-gate")>(), guardExactLoopAnswer: async function* (source: AsyncGenerator) { yield* source; } }));

const requestBody = { provider: "pi", prompt: `Loop ${loopId} 当前执行器正在运行吗？`, chatId, clientRequestId: "request-1", userMessageId: "66666666-6666-4666-8666-666666666666", assistantMessageId, allowedTools: [] };
function request(body: Record<string, unknown> = requestBody) { return new Request("http://localhost/api/native/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockImplementation(() => ({ run: async function* () { yield { type: "done" }; }, stop: vi.fn() }));
  mocks.createSession.mockImplementation(() => ({ mode: "enforce_critical", turnId, finalize: mocks.finalize, observeToolConstruction: vi.fn() }));
  mocks.finalize.mockResolvedValue({ auditPersisted: true });
  mocks.append.mockResolvedValue({ created: true });
  mocks.tools.mockReturnValue([]);
  mocks.authorizeRecords.mockResolvedValue({ allowed: true, status: "allowed" });
  vi.stubEnv("PLATFORM_ANSWER_MODE", "off");
});
afterEach(() => vi.unstubAllEnvs());

describe("native agent answer reservation boundary", () => {
  it("returns a running replay as 202 JSON without starting a model or a second session", async () => {
    vi.stubEnv("ANSWER_EVIDENCE_MODE", "enforce_critical");
    mocks.reserve.mockResolvedValue({ created: false, turnId, chatId, assistantMessageId, status: "running" });
    const { POST } = await import("@/app/api/native/agent/route");
    const response = await POST(request() as never);
    expect(response.status).toBe(202); expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ status: "running", queryUrl: `/api/native/answer-audits/${turnId}` });
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({ ownerId: owner, chatId, assistantMessageId, requestPayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.createSession).not.toHaveBeenCalled();
  });
  it("replays a stored failed terminal without promoting it or starting another model", async () => {
    vi.stubEnv("ANSWER_EVIDENCE_MODE", "shadow");
    const runtimeTerminal = { schemaVersion: "agent-runtime-terminal.v1", status: "failed", cleanupStatus: "failed" };
    mocks.reserve.mockResolvedValue({ created: false, turnId, chatId, assistantMessageId, status: "failed", runtimeTerminal });
    const { POST } = await import("@/app/api/native/agent/route");
    const response = await POST(request() as never); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "failed", runtimeTerminal });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.createSession).not.toHaveBeenCalled();
  });
  it("propagates owner or payload conflicts before model creation", async () => {
    vi.stubEnv("ANSWER_EVIDENCE_MODE", "enforce_critical");
    const { AgentAnswerAuditError } = await import("@/lib/db/agent-answer-audits");
    const { POST } = await import("@/app/api/native/agent/route");
    for (const error of [new AgentAnswerAuditError("answer_request_conflict", 409, "Request conflict"), new AgentAnswerAuditError("chat_not_owned", 403, "Chat not owned")]) {
      mocks.reserve.mockRejectedValueOnce(error);
      expect((await POST(request({ ...requestBody, ownerId: "forged-owner" }) as never)).status).toBe(error.status);
      expect(mocks.reserve).toHaveBeenLastCalledWith(expect.objectContaining({ ownerId: owner }));
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("keeps mode off and incomplete legacy bindings away from the audit repository", async () => {
    const { POST } = await import("@/app/api/native/agent/route");
    for (const [mode, body] of [["off", requestBody], ["enforce_critical", { ...requestBody, assistantMessageId: undefined }]] as const) {
      vi.stubEnv("ANSWER_EVIDENCE_MODE", mode);
      const response = await POST(request(body) as never);
      expect(response.status).toBe(200); await response.text();
    }
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.createSession).not.toHaveBeenCalled();
  });
  it("seals a reserved request if runtime setup fails before SSE begins", async () => {
    vi.stubEnv("ANSWER_EVIDENCE_MODE", "enforce_critical");
    mocks.reserve.mockResolvedValue({ created: true, turnId, chatId, assistantMessageId, status: "running" });
    mocks.create.mockImplementation(() => { throw new Error("Synthetic runtime setup failure"); });
    const { POST } = await import("@/app/api/native/agent/route");
    const response = await POST(request() as never); expect(response.status).toBe(500);
    expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({ terminal: expect.objectContaining({ status: "failed", cleanupStatus: "failed" }) }));
  });
  it("seals cancellation when the first audit-reference frame cannot be delivered", async () => {
    vi.stubEnv("ANSWER_EVIDENCE_MODE", "enforce_critical");
    mocks.reserve.mockResolvedValue({ created: true, turnId, chatId, assistantMessageId, status: "running" });
    const run = vi.fn(async function* () { yield { type: "done" }; });
    mocks.create.mockImplementation(() => ({ run, stop: vi.fn() }));
    const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue")
      .mockImplementationOnce(() => { throw new Error("Synthetic disconnected transport"); });
    try {
      const { POST } = await import("@/app/api/native/agent/route");
      const response = await POST(request() as never);
      await response.text();
      expect(run).not.toHaveBeenCalled();
      expect(mocks.finalize).toHaveBeenCalledTimes(1);
      expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({ status: "aborted", cleanupStatus: "failed", completionScope: "answer_delivery" }),
        rawDraft: "",
      }));
    } finally { enqueue.mockRestore(); }
  });
  it("pins the actual loaded model separately from request intent before execution", async () => {
    vi.stubEnv("ANSWER_EVIDENCE_MODE", "enforce_critical");
    mocks.reserve.mockResolvedValue({ created: true, turnId, chatId, assistantMessageId, status: "running" });
    const { POST } = await import("@/app/api/native/agent/route");
    const response = await POST(request({ ...requestBody, modelConfig: { model: "requested-model" } }) as never);
    expect(response.status).toBe(200); await response.text();
    const reservedIntent = mocks.reserve.mock.calls[0][0];
    expect(reservedIntent.payload.runtimeSnapshot.schemaVersion).toBe("answer-request-config-intent.v1");
    const loaded = mocks.append.mock.calls.find(([value]) => value.eventType === "runtime_loaded")?.[0];
    expect(loaded.payload.model).toBe("fake-model");
    expect(loaded.payload.actualRuntimeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.payload.actualRuntimeHash).not.toBe(reservedIntent.runtimeHash);
    expect(mocks.createSession.mock.calls.at(-1)?.[0].runtimeHash).toBe(loaded.payload.actualRuntimeHash);
    expect(mocks.create.mock.calls[0][0].model).toBe("fake-model");
  });
  it("uses the platform gate with one reservation and restricts registered tools before the first model request", async () => {
    vi.stubEnv("ANSWER_EVIDENCE_MODE", "off"); vi.stubEnv("PLATFORM_ANSWER_MODE", "enforce_supported");
    mocks.reserve.mockResolvedValue({ created: true, turnId, chatId, assistantMessageId, status: "running" });
    mocks.tools.mockReturnValue(["platformRecall", "time", "proposeWorkshopAgentChange"].map(name => ({ name })));
    const run = vi.fn(async function* (_prompt: string, options: any) {
      expect(options.runtimeTools.map((tool: any) => tool.name)).toEqual(["platformRecall", "time"]);
      expect(typeof options.onToolContextCommitted).toBe("function");
      yield { type: "text", content: "an unsupported fabricated output" };
      yield { type: "result", content: "an unsupported fabricated output" };
      yield { type: "runtime_terminal", runtimeTerminal: { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" } };
      yield { type: "done" };
    });
    mocks.create.mockImplementation(() => ({ run, stop: vi.fn() }));
    const { POST } = await import("@/app/api/native/agent/route");
    const response = await POST(request({ ...requestBody, prompt: `loopRuns ${loopId} 的输出结果是什么？`, allowedTools: undefined }) as never);
    const frames = await response.text();
    expect(frames).not.toContain("an unsupported fabricated output");
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.reserve.mock.calls[0][0].payload.runtimeSnapshot.scope).toBe("supported_platform_readonly");
    expect(mocks.append.mock.calls.filter(([event]) => event.eventType === "final_evidence")).toHaveLength(1);
    expect(mocks.append.mock.calls.find(([event]) => event.eventType === "final_evidence")?.[0].payload.schemaVersion).toBe("platform-answer-decision.v1");
    expect(mocks.authorizeRecords).toHaveBeenCalledWith(expect.objectContaining({ userId: owner, subjects: [{ source: "loopRuns", id: loopId }] }));
  });
  it("keeps mixed read-and-action requests outside the new read-only contract", async () => {
    vi.stubEnv("ANSWER_EVIDENCE_MODE", "off"); vi.stubEnv("PLATFORM_ANSWER_MODE", "enforce_supported");
    const { POST } = await import("@/app/api/native/agent/route");
    const response = await POST(request({ ...requestBody, prompt: `读取 loopRuns ${loopId} 并删除它` }) as never);
    await response.text(); expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("adds the selected message interpretation contract to the actual main prompt and loaded snapshot", async () => {
    vi.stubEnv("ANSWER_EVIDENCE_MODE", "off"); vi.stubEnv("PLATFORM_ANSWER_MODE", "enforce_supported");
    mocks.reserve.mockResolvedValue({ created: true, turnId, chatId, assistantMessageId, status: "running" });
    mocks.tools.mockReturnValue([{ name: "platformRecall" }]);
    const originalQuestion = `Message_v2 ${assistantMessageId} 这条聊天消息表达了什么，出自哪个聊天、哪个角色？它是否明确包含用户已经作出的决定？`;
    const run = vi.fn(async function* (prompt: string) {
      expect(prompt).toContain(originalQuestion);
      expect(prompt).toContain("platform-message-interpretation.v1");
      expect(prompt).toContain("最终答文从 ```platform-message-interpretation 开始");
      expect(prompt).toContain("不要复述全部文本段");
      expect(prompt).toContain("not_found_in_read_text");
      yield { type: "result", content: "" };
      yield { type: "runtime_terminal", runtimeTerminal: { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" } };
      yield { type: "done" };
    });
    mocks.create.mockImplementation(() => ({ run, stop: vi.fn() }));
    const { POST } = await import("@/app/api/native/agent/route");
    await (await POST(request({ ...requestBody, prompt: originalQuestion, allowedTools: undefined }) as never)).text();
    expect(run).toHaveBeenCalledOnce();
    const loaded = mocks.append.mock.calls.find(([event]) => event.eventType === "runtime_loaded")?.[0];
    expect(loaded.payload).toMatchObject({ messageInterpretationInstructionVersion: "platform-message-interpretation.v1", messageInterpretationInstructionHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it("does not request structured message interpretation when the selected mode is off", async () => {
    vi.stubEnv("ANSWER_EVIDENCE_MODE", "off"); vi.stubEnv("PLATFORM_ANSWER_MODE", "off");
    const run = vi.fn(async function* (prompt: string) {
      expect(prompt).not.toContain("platform-message-interpretation.v1");
      yield { type: "done" };
    });
    mocks.create.mockImplementation(() => ({ run, stop: vi.fn() }));
    const { POST } = await import("@/app/api/native/agent/route");
    await (await POST(request({ ...requestBody, prompt: `Message_v2 ${assistantMessageId} 表达了什么？` }) as never)).text();
    expect(run).toHaveBeenCalledOnce(); expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
