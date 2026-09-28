import { describe, expect, it, vi } from "vitest";
import {
  checkWechatDesktopHealth,
  previewWechatDesktopMessageForReview,
} from "@/lib/ai/wechat-desktop-read-tools";

describe("WeChat desktop read tool adapter", () => {
  it("returns service health without creating a preview or sending", async () => {
    const getHealth = vi.fn(async () => ({
      ok: true,
      service: "wechat-desktop",
      uptimeSeconds: 12,
      wxautoAvailable: true,
    }));
    const getConfig = vi.fn(() => ({
      url: "http://127.0.0.1:8765",
      hasToken: true,
    }));

    const result = await checkWechatDesktopHealth({
      getHealth,
      getConfig,
    });

    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      data: {
        success: true,
        config: {
          url: "http://127.0.0.1:8765",
          hasToken: true,
        },
        health: {
          ok: true,
          service: "wechat-desktop",
        },
      },
      isError: false,
    });
  });

  it("returns a visible error when the local service is unreachable", async () => {
    const getHealth = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const getConfig = vi.fn(() => ({
      url: "http://127.0.0.1:8765",
      hasToken: false,
    }));

    const result = await checkWechatDesktopHealth({
      getHealth,
      getConfig,
    });

    expect(result).toMatchObject({
      ok: false,
      data: {
        success: false,
        message: "connection refused",
      },
      isError: true,
    });
    expect(result.text).toContain("connection refused");
  });

  it("creates a reviewable message preview without sending", async () => {
    const previewMessage = vi.fn(async () => ({
      ok: true,
      requiresConfirmation: true,
      confirmToken: "confirm-1",
      expiresInSeconds: 300,
      preview: {
        recipientName: "Alice",
        message: "hello",
        messageHash: "hash-1",
      },
    }));

    const result = await previewWechatDesktopMessageForReview({
      recipientName: "Alice",
      message: "hello",
      previewMessage,
    });

    expect(previewMessage).toHaveBeenCalledWith({
      recipientName: "Alice",
      message: "hello",
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        success: true,
        preview: {
          confirmToken: "confirm-1",
          preview: {
            recipientName: "Alice",
          },
        },
      },
      isError: false,
    });
    expect(result.text).toContain("Do not call any send tool");
  });
});
