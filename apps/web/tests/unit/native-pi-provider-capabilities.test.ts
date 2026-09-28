import { describe, expect, it } from "vitest";
import { getNativePiProviderCapabilityBlock } from "@/lib/ai/native-pi-provider-capabilities";

describe("native Pi provider capability boundary", () => {
  it("allows text, read-only time/webSearch/manifest review/agent inspection/knowledge document/chat insight/contact/Brain read and grant list/Loop list/WeChat health tools, owner-scoped Loop status controls, owner-reviewable previews/proposals, text attachments, workspace text files, RAG, and skills run, plan, and execute requests", () => {
    expect(
      getNativePiProviderCapabilityBlock({
        provider: "pi",
      }),
    ).toBeNull();
    expect(
      getNativePiProviderCapabilityBlock({
        provider: "pi",
        phase: "plan",
        permissionMode: "default",
      }),
    ).toBeNull();
    expect(
      getNativePiProviderCapabilityBlock({
        provider: "pi",
        phase: "execute",
        fileAttachments: [
          { name: "notes.md", mimeType: "text/markdown" },
          { name: "data.json", mimeType: "application/json" },
          { name: "report.pdf", mimeType: "application/pdf" },
          {
            name: "proposal.docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
        ragDocuments: [{ id: "doc-1", name: "doc.md" }],
        skillsConfig: { enabled: true },
        allowedTools: [
          "time",
          "webSearch",
          "setLoopTaskStatus",
          "proposeInsightChange",
          "proposeWorkshopLoopTask",
        ],
      }),
    ).toBeNull();
  });

  it("blocks unsupported rich Web Chat capabilities instead of ignoring them", () => {
    const block = getNativePiProviderCapabilityBlock({
      provider: "pi",
      images: [{}],
      fileAttachments: [{ name: "archive.zip", mimeType: "application/zip" }],
      mcpConfig: { enabled: true },
      sandboxConfig: {},
      permissionMode: "bypassPermissions",
      allowedTools: ["createInsight", "Bash"],
    });

    expect(block?.error).toContain(
      "read-only time/webSearch/workshop manifest capability/review/agent inspection/knowledge document list/full document read/search/unified memory/memory path/chat insight/contact query/Brain read and grant list/Loop list/WeChat health tools, owner-scoped Loop status controls, owner-reviewable WeChat message previews, workshop change proposals, Insight change proposals, paused Loop task and Loop change proposals",
    );
    expect(
      block,
    ).toMatchObject({
      status: 400,
      unsupportedCapabilities: [
        "tools:createInsight",
        "tools:Bash",
        "images",
        "file_attachments",
        "mcp",
        "sandbox",
        "permission_mode",
      ],
    });
  });

  it("does not affect Claude requests", () => {
    expect(
      getNativePiProviderCapabilityBlock({
        provider: "claude",
        phase: "plan",
        images: [{}],
      }),
    ).toBeNull();
  });
});
