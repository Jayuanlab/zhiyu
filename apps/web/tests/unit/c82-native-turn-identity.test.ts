import { describe, expect, it, vi } from "vitest";
import * as native from "@/lib/ai/native-pi-web-chat-tools";
import {
  PlatformReadHandleRegistry,
  type PlatformReadIdentity,
} from "@/lib/ai/platform-read-handle-registry";
import type { NativePiWebChatToolsInput } from "@/lib/ai/native-pi-web-chat-tools";

type TurnIdInput = { answerSessionTurnId?: string; partialTurnId?: string };
const partialTurnId = "e29dfe8c-fafc-4a55-8eaf-b109df436ee9";
const answerSessionTurnId = "b1c7fdfb-b25d-4872-938d-a3f662f875b8";
const recordId = "d068e741-c8c9-423a-a685-2c7b6da31361";
const now = () => new Date("2026-10-04T00:00:00.000Z");

function resolveTurn(input: TurnIdInput): string {
  const resolver = (native as unknown as {
    resolveNativePiWebChatTurnId?: (input: TurnIdInput) => string;
  }).resolveNativePiWebChatTurnId;
  // The first red is specifically the absent new export, not a claim that
  // existing identity validation failed or a reconstruction of route execution.
  expect(resolver, "resolveNativePiWebChatTurnId export must exist").toBeTypeOf("function");
  return resolver!(input);
}

function identity(turnId: string): PlatformReadIdentity {
  return { ownerId: "identity-owner", requester: { kind: "chat", id: "identity-chat" }, turnId };
}

function boundInput(turnId: string): NativePiWebChatToolsInput {
  const platformReadIdentity = identity(turnId);
  return {
    userId: platformReadIdentity.ownerId,
    turnId,
    platformReadIdentity,
    platformReadRegistry: new PlatformReadHandleRegistry(platformReadIdentity),
    includeMemoryAccess: false,
    now,
  };
}

function assertBothFactoriesReject(input: NativePiWebChatToolsInput, message: string) {
  expect(() => native.createNativePiWebChatToolDefinitions(input)).toThrow(message);
  expect(() => native.createNativePiWebChatTools(input)).toThrow(message);
}

function recallDefinitions(input: NativePiWebChatToolsInput, recall: ReturnType<typeof vi.fn>) {
  const args: Parameters<typeof native.createNativePiWebChatToolDefinitions> = [];
  args[0] = input;
  args[22] = recall as never;
  return native.createNativePiWebChatToolDefinitions(...args);
}

describe("C82 native host turn identity", () => {
  it("uses the reserved partial turn for the real registry and both native factories", async () => {
    const turnId = resolveTurn({ partialTurnId });
    expect(turnId).toBe(partialTurnId);
    const input = boundInput(turnId);
    const handle = input.platformReadRegistry!.register({
      source: "loopRuns", id: recordId, fieldKey: "outputSummary", contentHash: "a".repeat(64),
    });
    const recall = vi.fn(async () => ({ ok: true, text: "finite identity fixture" }));
    const definition = recallDefinitions(input, recall).find(tool => tool.name === "platformRecall")!;
    await definition.execute({ readHandle: handle.readHandle }, { toolCallId: "partial-read" });
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({
      userId: "identity-owner", platformReadIdentity: identity(partialTurnId),
      platformReadRegistry: input.platformReadRegistry, readHandle: handle.readHandle,
    }));
    expect(input.platformReadRegistry!.resolve(handle.readHandle, identity(partialTurnId)).turnId).toBe(partialTurnId);
    const time = native.createNativePiWebChatTools(input).find(tool => tool.name === "time")!;
    const result = await time.execute("partial-time", { format: "iso", timezone: "UTC" });
    expect(result.details).toMatchObject({
      result: { currentTime: "2026-10-04T00:00:00.000Z" }, trace: { status: "completed" },
    });
  });

  it("prefers the answer session turn over a simultaneous partial reservation", async () => {
    const turnId = resolveTurn({ answerSessionTurnId, partialTurnId });
    expect(turnId).toBe(answerSessionTurnId);
    const input = boundInput(turnId);
    expect(native.createNativePiWebChatToolDefinitions(input).some(tool => tool.name === "platformRecall")).toBe(true);
    const time = native.createNativePiWebChatTools(input).find(tool => tool.name === "time")!;
    expect((await time.execute("session-time", { format: "iso", timezone: "UTC" })).details).toMatchObject({
      trace: { status: "completed" },
    });
    expect(() => input.platformReadRegistry!.assertIdentity(identity(partialTurnId))).toThrow("Invalid platform read handle scope");
  });

  it("creates distinct fresh UUIDs when neither host turn source exists", () => {
    const first = resolveTurn({});
    const second = resolveTurn({});
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(first).toMatch(uuid);
    expect(second).toMatch(uuid);
    expect(first).not.toBe(second);
    for (const turnId of [first, second]) {
      const input = boundInput(turnId);
      expect(native.createNativePiWebChatToolDefinitions(input).length).toBeGreaterThan(0);
      expect(native.createNativePiWebChatTools(input).length).toBeGreaterThan(0);
      input.platformReadRegistry!.assertIdentity(identity(turnId));
    }
  });

  it("keeps turn selection out of tool schemas and ignores model identity overrides", async () => {
    const input = boundInput(partialTurnId);
    const recall = vi.fn(async () => ({ ok: true, text: "finite identity fixture" }));
    const definitions = recallDefinitions(input, recall);
    const tools = native.createNativePiWebChatTools({ ...input, includeMemoryAccess: true });
    for (const tool of [...definitions, ...tools]) {
      const schema = JSON.stringify(tool.parameters);
      for (const hostField of ["answerSessionTurnId", "partialTurnId", "platformReadIdentity", "platformReadRegistry", "turnId"]) {
        expect(schema).not.toContain('"' + hostField + '"');
      }
    }
    const definition = definitions.find(tool => tool.name === "platformRecall")!;
    await definition.execute({
      question: "finite fixture", turnId: answerSessionTurnId,
      answerSessionTurnId, partialTurnId: answerSessionTurnId,
      platformReadIdentity: identity(answerSessionTurnId), platformReadRegistry: "model-controlled",
    } as never, { toolCallId: "model-override" });
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({
      platformReadIdentity: identity(partialTurnId), platformReadRegistry: input.platformReadRegistry,
    }));
  });

  it("rejects the wrong owner in both native factories", () => {
    assertBothFactoriesReject({ ...boundInput(partialTurnId), userId: "another-owner" }, "Invalid platform read identity");
  });

  it("rejects a tool turn different from the bound identity in both native factories", () => {
    assertBothFactoriesReject({ ...boundInput(partialTurnId), turnId: answerSessionTurnId }, "Invalid platform read identity");
  });

  it("rejects a registry bound to another identity in both native factories", () => {
    assertBothFactoriesReject({
      ...boundInput(partialTurnId), platformReadRegistry: new PlatformReadHandleRegistry(identity(answerSessionTurnId)),
    }, "Invalid platform read handle scope");
  });

  it("preserves denied-before-allowed and approval guards with a correctly bound partial identity", async () => {
    const input = boundInput(partialTurnId);
    for (const policy of [
      { allowedTools: ["time"], deniedTools: ["time"] },
      { allowedTools: ["time"], requiresApprovalTools: ["time"] },
    ]) {
      const onResultConstructed = vi.fn();
      const onTrace = vi.fn();
      const guardedNow = vi.fn(now);
      const time = native.createNativePiWebChatTools({
        ...input, policy, onResultConstructed, onTrace, now: guardedNow,
      }).find(tool => tool.name === "time")!;
      await expect(time.execute("denied-time", { format: "iso" })).rejects.toThrow(
        "deniedTools" in policy ? "Tool denied by runtime policy." : "owner approval",
      );
      expect(guardedNow).not.toHaveBeenCalled();
      expect(onResultConstructed).not.toHaveBeenCalled();
      expect(onTrace).toHaveBeenCalledWith(expect.objectContaining({
        status: "denied", metadata: expect.objectContaining({ deniedBeforeHandler: true }),
      }));
    }
  });
});
