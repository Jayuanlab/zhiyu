import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  previewWechatDesktopMessage,
  sendWechatDesktopMessage,
} from "@/lib/wechat-desktop/client";
import {
  checkWechatDesktopHealth,
  previewWechatDesktopMessageForReview,
} from "@/lib/ai/wechat-desktop-read-tools";

function jsonText(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function createWechatDesktopTools(options?: { includeSendTool?: boolean }) {
  const tools = [
    tool(
      "wechatDesktopHealth",
      [
        "Check whether the local desktop WeChat automation service is reachable.",
        "Use this before previewing or sending a WeChat desktop message if the user asks whether WeChat control is available.",
        "This tool never opens WeChat and never sends a message.",
      ].join("\n"),
      {},
      async () => {
        const result = await checkWechatDesktopHealth();
        return {
          content: [
            {
              type: "text" as const,
              text: result.text,
            },
          ],
          data: result.data,
          isError: result.isError,
        };
      },
    ),
    tool(
      "wechatDesktopPreviewMessage",
      [
        "Prepare a desktop WeChat message and return a one-time confirmToken.",
        "This only creates a preview in the local service. It does NOT open WeChat and does NOT send anything.",
        "Use this when the user asks to send a WeChat message through the local Windows WeChat client.",
        "After previewing, tell the user to click the confirmation button shown in the UI. Do not send the message yourself.",
      ].join("\n"),
      {
        recipientName: z
          .string()
          .min(1)
          .describe(
            "Exact WeChat contact, group, or chat name as it appears in desktop WeChat.",
          ),
        message: z.string().min(1).describe("Plain text message to send."),
      },
      async ({ recipientName, message }) => {
        const result = await previewWechatDesktopMessageForReview({
          recipientName,
          message,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: result.text,
            },
          ],
          data: result.data,
          isError: result.isError,
        };
      },
    ),
  ];

  if (options?.includeSendTool) {
    tools.push(
      tool(
        "wechatDesktopSendMessage",
        [
          "Send a message through the local Windows desktop WeChat client.",
          "This tool is only for approved background loop execution.",
          "Do not expose or use this tool in ordinary chat turns.",
          "The tool creates a local preview token internally, then immediately sends the exact same recipient/message pair.",
        ].join("\n"),
        {
          recipientName: z
            .string()
            .min(1)
            .describe(
              "Exact WeChat contact, group, or chat name as it appears in desktop WeChat.",
            ),
          message: z.string().min(1).describe("Plain text message to send."),
        },
        async ({ recipientName, message }) => {
          try {
            const preview = await previewWechatDesktopMessage({
              recipientName,
              message,
            });
            const sent = await sendWechatDesktopMessage({
              recipientName,
              message,
              confirmToken: preview.confirmToken,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: jsonText({
                    success: true,
                    preview,
                    sent,
                  }),
                },
              ],
              data: sent,
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: jsonText({
                    success: false,
                    message:
                      error instanceof Error ? error.message : String(error),
                  }),
                },
              ],
              isError: true,
            };
          }
        },
      ),
    );
  }

  return tools;
}
