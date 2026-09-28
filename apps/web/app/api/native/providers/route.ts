/**
 * Native Providers API Routes
 *
 * Get available agent and sandbox providers
 */

import { NextResponse } from "next/server";
import { getAgentRegistry } from "@openzhiyu/ai/agent/registry";
import { getAllAgentMetadata } from "@openzhiyu/ai/agent/registry";
import { claudePlugin, piPlugin } from "@/lib/ai/extensions";
import { resolveDefaultNativeAgentProvider } from "@/lib/ai/native-agent-default-provider";

// Register native agent plugins
getAgentRegistry().register(claudePlugin);
getAgentRegistry().register(piPlugin);

// GET /api/native/providers - Get all available providers
export async function GET() {
  try {
    const agentProviders = getAllAgentMetadata();
    const defaultProvider = resolveDefaultNativeAgentProvider();

    return NextResponse.json({
      agents: agentProviders,
      defaultAgent: defaultProvider.provider,
      defaultAgentSource: defaultProvider.source,
    });
  } catch (error) {
    console.error("[ProvidersAPI] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get providers",
      },
      { status: 500 },
    );
  }
}
