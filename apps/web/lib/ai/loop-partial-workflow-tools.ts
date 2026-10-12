import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createGuardedPiTool } from "./runtime/pi-tool-adapter";
import type { OwnerLoopPartialHost } from "./loop-partial-host";

/** Existing owner fixture RPC performs the read. This adapter only records the actual formatted result. */
export function wrapOwnerLoopWorkflowReaders(tools: AgentTool[], getHost: () => OwnerLoopPartialHost | undefined): AgentTool[] {
  return tools.map(tool => ["readLoopRuntimeObservation", "readLoopRunTimeline", "readRunRecord"].includes(tool.name)
    ? createGuardedPiTool({ name: tool.name, label: tool.label, description: tool.description,
      parameters: tool.parameters, replay: tool.replay, executionMode: tool.executionMode,
      policy: { allowedTools: [tool.name], defaultDecision: "deny" },
      execute: async (params, { toolCallId, signal }) => {
        const result = await tool.execute(toolCallId, params, signal);
        const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        return JSON.parse(text) as unknown;
      }, formatResult: result => JSON.stringify(result),
      onResultConstructed: receipt => getHost()?.onResultConstructed(receipt) }) : tool);
}
