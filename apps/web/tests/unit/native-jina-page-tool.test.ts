import { beforeEach, describe, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
const figureRead = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/jina-page-reader", () => ({ readJinaDefuddlePage: read }));
vi.mock("@/lib/ai/web-figure-reader", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/ai/web-figure-reader")>(), readWebFigure: figureRead }));
import { createNativePiWebChatTools } from "@/lib/ai/native-pi-web-chat-tools";

describe("native saved web evidence boundary", () => {
  it("forwards figure operations within the same permission and user boundary", async () => {
    figureRead.mockReset();
    figureRead.mockResolvedValue({ metadata: { status: "rendered" }, image: { type: "image", data: "cG5n", mimeType: "image/png" } });
    const tool = createNativePiWebChatTools({ userId: "owner" }).find(t => t.name === "webReadPage")!;
    const result = await tool.execute("figure", { url: "https://example.com", evidenceId: "saved", figureId: "figure-1" });
    expect(figureRead).toHaveBeenCalledWith(expect.objectContaining({ scope: "user:owner", figureId: "figure-1" }));
    expect(result.content[1]).toMatchObject({ type: "image" });
    const denied = createNativePiWebChatTools({ userId: "owner", policy: { deniedTools: ["webReadPage"] } }).find(t => t.name === "webReadPage")!;
    await expect(denied.execute("denied", { url: "https://example.com", evidenceId: "saved", figureId: "figure-1" })).rejects.toThrow("denied");
    expect(figureRead).toHaveBeenCalledOnce();
  });
  beforeEach(() => { read.mockReset(); read.mockResolvedValue({ ok: true, evidenceId: "saved", nextOffset: 1000 }); });
  it("binds evidence to trusted user identity and supports another window", async () => {
    const tool = createNativePiWebChatTools({ userId: "owner" }).find(t => t.name === "webReadPage")!;
    await tool.execute("first", { url: "https://example.com", scope: "user:other" });
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "user:owner" }));
    await tool.execute("next", { url: "https://example.com", evidenceId: "saved", offset: 1000 });
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "user:owner", evidenceId: "saved", offset: 1000 }));
    await expect(tool.execute("duplicate", { url: "https://example.com", evidenceId: "saved", offset: 1000 })).rejects.toThrow(/already/);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("denies unauthenticated and policy-denied reads before external access", async () => {
    const anonymous = createNativePiWebChatTools().find(t => t.name === "webReadPage")!;
    await expect(anonymous.execute("anonymous", { url: "https://example.com" })).rejects.toThrow("identity");
    const denied = createNativePiWebChatTools({ userId: "owner", policy: { deniedTools: ["webReadPage"] } }).find(t => t.name === "webReadPage")!;
    await expect(denied.execute("denied", { url: "https://example.com" })).rejects.toThrow("denied");
    expect(read).not.toHaveBeenCalled();
  });
});
