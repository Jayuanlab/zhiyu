import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import {
  createWorkshopInternalWritePiTools,
  WORKSHOP_INTERNAL_WRITE_PI_TOOLS,
} from "@/lib/workshops/pi-internal-write-tools";
import { buildWorkshopRuntimeToolPolicy } from "@/lib/workshops/tool-classification";

const appendWorkshopEventMock = vi.hoisted(() => vi.fn());
const addWorkshopMemoryMock = vi.hoisted(() => vi.fn());
const addWorkshopMemoryWithContextMock = vi.hoisted(() => vi.fn());
const withExecutionWriteMock = vi.hoisted(() => vi.fn());
const withExecutionBusinessWriteMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/workshops/service", () => ({
  appendWorkshopEvent: appendWorkshopEventMock,
  addWorkshopMemory: addWorkshopMemoryMock,
  addWorkshopMemoryWithContext: addWorkshopMemoryWithContextMock,
}));

vi.mock("@/lib/work-runtime/execution-lease", () => ({
  withExecutionWrite: withExecutionWriteMock,
  withExecutionBusinessWrite: withExecutionBusinessWriteMock,
}));

describe("Workshop Pi internal write tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appendWorkshopEventMock.mockImplementation(async (input) => ({
      id: "event-1",
      ...input,
    }));
    addWorkshopMemoryMock.mockImplementation(async (input) => ({
      id: "memory-1",
      kind: input.kind,
      status: input.status,
      confidence: input.confidence,
      content: input.content,
    }));
    addWorkshopMemoryWithContextMock.mockImplementation(
      async (input, _context) => ({
        id: "memory-lease",
        kind: input.kind,
        status: input.status,
        confidence: input.confidence,
        content: input.content,
      }),
    );
    withExecutionWriteMock.mockImplementation(async (_lease, write) =>
      write({
        append: vi.fn(async (input) => ({
          id: "event-lease",
          ...input,
        })),
      }),
    );
    withExecutionBusinessWriteMock.mockImplementation(async (_lease, write) => write({db:{},append:vi.fn()}));
  });

  it("writes a scoped workshop log event under deny-by-default policy", async () => {
    const onTrace = vi.fn();
    const policy = buildWorkshopRuntimeToolPolicy([
      ...WORKSHOP_INTERNAL_WRITE_PI_TOOLS,
      "quantPaperPlaceOrder",
    ]);
    const tools = createWorkshopInternalWritePiTools({
      workshopId: "workshop-1",
      runId: "run-1",
      policy,
      onTrace,
    });
    const tool = tools.find((item) => item.name === "workshopLogEvent");

    const result = await tool?.execute("tool-1", {
      type: "decision",
      title: "No notification needed",
      body: "The observation can stay in the run log.",
      metadata: { confidence: 80 },
    });

    expect(result?.details.result).toMatchObject({
      ok: true,
      eventId: "event-1",
      type: "decision",
      title: "No notification needed",
    });
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        runId: "run-1",
        type: "decision",
        title: "No notification needed",
        metadata: expect.objectContaining({
          confidence: 80,
          source: "pi_internal_write_tool",
          tool: "workshopLogEvent",
        }),
      }),
    );
    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "workshopLogEvent",
        status: "completed",
      }),
    );
  });

  it("keeps explicit denied policy above internal write promotion", async () => {
    const tools = createWorkshopInternalWritePiTools({
      workshopId: "workshop-1",
      policy: {
        allowedTools: ["workshopLogEvent"],
        deniedTools: ["workshopLogEvent"],
        defaultDecision: "deny",
      },
    });
    const tool = tools.find((item) => item.name === "workshopLogEvent");

    await expect(
      tool?.execute("tool-2", {
        title: "should not write",
      }),
    ).rejects.toThrow("Tool denied by runtime policy.");
    expect(appendWorkshopEventMock).not.toHaveBeenCalled();
  });

  it("writes workshop memory through the host memory guard", async () => {
    const policy = buildWorkshopRuntimeToolPolicy([
      "workshopWriteMemory",
      "quantPaperPlaceOrder",
    ]);
    const tools = createWorkshopInternalWritePiTools({
      workshopId: "workshop-1",
      policy,
    });
    const tool = tools.find((item) => item.name === "workshopWriteMemory");

    const result = await tool?.execute("tool-memory", {
      kind: "boundary",
      content: "Only draft external messages unless owner approves.",
      confidence: 88,
      tags: ["boundary", "owner"],
      sourceEventIds: ["event-1", "event-1"],
      status: "active",
    });

    expect(result?.details.result).toMatchObject({
      ok: true,
      memoryId: "memory-1",
      kind: "boundary",
      status: "active",
      confidence: 88,
    });
    expect(addWorkshopMemoryMock).toHaveBeenCalledWith({
      workshopId: "workshop-1",
      kind: "boundary",
      content: "Only draft external messages unless owner approves.",
      confidence: 88,
      tags: ["boundary", "owner"],
      sourceEventIds: ["event-1"],
      status: "active",
    });
  });

  it("uses the execution lease writer for workshop memory when available", async () => {
    const lease = {
      userId: "user-1",
      workshopId: "workshop-1",
      runId: "run-1",
      workerId: "worker-1",
      token: 3,
    };
    const tools = createWorkshopInternalWritePiTools({
      workshopId: "workshop-1",
      executionLease: lease,
      policy: {
        allowedTools: ["workshopWriteMemory"],
        defaultDecision: "deny",
      },
    });
    const tool = tools.find((item) => item.name === "workshopWriteMemory");

    const result = await tool?.execute("tool-memory-lease", {
      content: "Lease guarded memory.",
    });

    expect(result?.details.result).toMatchObject({
      memoryId: "memory-lease",
      kind: "finding",
      status: "candidate",
    });
    expect(withExecutionBusinessWriteMock).toHaveBeenCalledWith(
      lease,
      expect.any(Function),
    );
    expect(addWorkshopMemoryWithContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        kind: "finding",
        content: "Lease guarded memory.",
        status: "candidate",
      }),
      expect.any(Object),
    );
    expect(addWorkshopMemoryMock).not.toHaveBeenCalled();
  });
  it("blocks business memory while preserving the leased raw observation audit", async () => {
    withExecutionBusinessWriteMock.mockRejectedValueOnce(new Error('memory dependency stale fixture'));
    const tools=createWorkshopInternalWritePiTools({workshopId:'workshop-1',runId:'run-1',executionLease:{userId:'user-1',workshopId:'workshop-1',runId:'run-1',workerId:'worker-1',token:3},policy:{allowedTools:['workshopWriteMemory','workshopLogEvent'],defaultDecision:'deny'}});
    await expect(tools.find(tool=>tool.name==='workshopWriteMemory')!.execute('stale-memory',{content:'Must not be written'})).rejects.toThrow('memory dependency stale fixture');
    expect(addWorkshopMemoryWithContextMock).not.toHaveBeenCalled();expect(addWorkshopMemoryMock).not.toHaveBeenCalled();
    const observed=await tools.find(tool=>tool.name==='workshopLogEvent')!.execute('raw-observation',{type:'observation',title:'Source requires revalidation',body:'Synthetic explicit audit'});
    expect(observed.details.result).toMatchObject({eventId:'event-lease'});expect(withExecutionWriteMock).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit deny above workshop memory promotion", async () => {
    const tools = createWorkshopInternalWritePiTools({
      workshopId: "workshop-1",
      policy: {
        allowedTools: ["workshopWriteMemory"],
        deniedTools: ["workshopWriteMemory"],
        defaultDecision: "deny",
      },
    });
    const tool = tools.find((item) => item.name === "workshopWriteMemory");

    await expect(
      tool?.execute("tool-memory-denied", {
        content: "should not write",
      }),
    ).rejects.toThrow("Tool denied by runtime policy.");
    expect(addWorkshopMemoryMock).not.toHaveBeenCalled();
    expect(addWorkshopMemoryWithContextMock).not.toHaveBeenCalled();
  });

  it("uses the execution lease writer when a lease is available", async () => {
    const lease = {
      userId: "user-1",
      workshopId: "workshop-1",
      runId: "run-1",
      workerId: "worker-1",
      token: 3,
    };
    const tools = createWorkshopInternalWritePiTools({
      workshopId: "workshop-1",
      runId: "run-1",
      executionLease: lease,
      policy: {
        allowedTools: ["workshopLogEvent"],
        defaultDecision: "deny",
      },
    });
    const tool = tools.find((item) => item.name === "workshopLogEvent");

    const result = await tool?.execute("tool-3", {
      title: "lease guarded write",
    });

    expect(result?.details.result).toMatchObject({
      eventId: "event-lease",
    });
    expect(withExecutionWriteMock).toHaveBeenCalledWith(
      lease,
      expect.any(Function),
    );
    expect(appendWorkshopEventMock).not.toHaveBeenCalled();
  });

  it("runs workshopLogEvent through the Pi runtime tool loop", async () => {
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("workshopLogEvent", {
          type: "observation",
          title: "runtime observation",
          body: "logged through Pi runtime",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("logged"),
    ]);
    const runtime = createPiAgentRuntime({
      model: faux.getModel(),
      streamFn: faux.streamSimple,
      tools: createWorkshopInternalWritePiTools({
        workshopId: "workshop-1",
        runId: "run-1",
        policy: { allowedTools: ["workshopLogEvent"], defaultDecision: "deny" },
      }),
      toolExecution: "sequential",
    });

    const messages = [];
    for await (const message of runtime.run({
      operation: "run",
      prompt: "log an observation",
      options: { sessionId: "pi-internal-write-session" },
    })) {
      messages.push(message);
    }

    expect(messages).toContainEqual({
      type: "tool_use",
      id: expect.any(String),
      name: "workshopLogEvent",
      input: {
        type: "observation",
        title: "runtime observation",
        body: "logged through Pi runtime",
      },
    });
    expect(
      messages.find((message) => message.type === "tool_result")?.output,
    ).toContain("event-1");
    expect(messages).toContainEqual({
      type: "result",
      content: "logged",
      cost: 0,
      answerPhase: "candidate_final",
    });
  });
});
