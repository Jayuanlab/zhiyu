/**
 * MCP Business Tools - Combined exports
 *
 * This module combines all business tool factories and creates the MCP server.
 */

import {
  createSdkMcpServer,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { Session } from "next-auth";
import type { InsightChangeCallback } from "./shared";

import { createTimeTool } from "./time";
import { createWebSearchTool } from "./web-search";
import { createChatInsightTool } from "./chat-insight";
import { createDownloadAttachmentTool } from "./download-attachment";
import { createContactsTool } from "./contacts";
import { createInsightCrudTools } from "./insight-crud";
import { createSearchKnowledgeTools } from "./search-knowledge";
import { createUnifiedMemorySearchTool } from "./unified-memory";
import { createBrainTools } from "./brain";
import { createMemoryPathTool } from "./memory-path";
import { createLoopTaskTools } from "./loop-tasks";
import { createWechatDesktopTools } from "./wechat-desktop";
import { createWorkshopAgentConfigTools } from "./workshop-agent-config";
import { createWorkshopManifestTools } from "./workshop-manifest";

export type BusinessToolsMcpOptions = {
  excludeTools?: string[];
  enableWechatDesktopSend?: boolean;
};

/**
 * Create business tools MCP server
 *
 * This server provides business logic tools that interact with the database
 * and external services. It requires a user session to function properly.
 *
 * @param session - User session for authentication and context
 * @param cloudAuthToken - Optional cloud auth token for embeddings API
 * @param onInsightChange - Optional callback to notify frontend of insight changes
 * @param chatId - Optional chat ID for associating insights with conversations
 * @param options - Optional runtime tool configuration
 * @returns MCP server instance
 */
export function createBusinessToolsMcpServer(
  session: Session,
  cloudAuthToken?: string,
  onInsightChange?: InsightChangeCallback,
  chatId?: string,
  options?: BusinessToolsMcpOptions,
) {
  // Store cloudAuthToken for embeddings API (needed when cloud calls tools)
  const embeddingsAuthToken = cloudAuthToken;
  const tools: SdkMcpToolDefinition<any>[] = [
    // time tool - no session needed
    createTimeTool(),

    // Web search owned by Zhiyu. Do not rely on Claude Code's built-in
    // WebSearch when running through Anthropic-compatible providers.
    createWebSearchTool(),

    // Session-based tools
    createChatInsightTool(session),
    createDownloadAttachmentTool(session, chatId),
    createContactsTool(session),

    // Insight CRUD tools
    ...createInsightCrudTools(
      session,
      chatId,
      onInsightChange,
      embeddingsAuthToken,
    ),

    // Search knowledge tools
    ...createSearchKnowledgeTools(session, embeddingsAuthToken),

    // Unified memory search tool
    createUnifiedMemorySearchTool(session, embeddingsAuthToken),

    // Brain-native memory tools
    ...createBrainTools(session),

    // Memory path tool
    createMemoryPathTool(session),

    // Native Loop task tools. Legacy scheduled_jobs tools are intentionally
    // not exposed to agents; all new timed/background tasks should be loops.
    ...createLoopTaskTools(session),

    // Workshop agent configuration proposals. Chat agents can inspect and
    // propose changes, while applying changes stays in the owner review UI.
    ...createWorkshopAgentConfigTools(session),

    // Workshop manifest authoring. Chat agents can guide users from intent to
    // reviewed YAML and create a workshop only after explicit user confirmation.
    ...createWorkshopManifestTools(session),

    // Local desktop WeChat tools
    ...createWechatDesktopTools({
      includeSendTool: options?.enableWechatDesktopSend,
    }),
  ];

  const excludeSet = new Set(options?.excludeTools ?? []);
  const filteredTools =
    excludeSet.size > 0
      ? tools.filter((businessTool) => {
          const toolName = (businessTool as { name: string }).name;
          return !excludeSet.has(toolName);
        })
      : tools;

  return createSdkMcpServer({
    name: "business-tools",
    version: "1.0.0",
    tools: filteredTools,
  });
}

// Re-export shared types for external use
export type { InsightChangeCallback, TaskInput } from "./shared";
export { INSIGHT_FILTER_KINDS } from "./shared";
