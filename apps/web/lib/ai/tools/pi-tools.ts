import { z } from 'zod';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { RuntimeToolDefinition, InProcessToolServer } from './definitions';
import {
  executeGuardedRuntimeTool,
  type RuntimeToolPolicy,
} from '../runtime/tool-executor';

export function adaptRuntimeToolDefinition(
  definition: RuntimeToolDefinition<any>,
): AgentTool<any> {
  const schema = z.object(definition.inputSchema);
  return {
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: Type.Unsafe(
      z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
    ),
    replay: 'never',
    executionMode: 'sequential',
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const parsed = await schema.parseAsync(params);
      signal?.throwIfAborted();
      const result = await definition.handler(parsed, { signal, toolCallId });
      signal?.throwIfAborted();
      if (result.isError)
        throw Error(
          (result.content ?? [])
            .filter((p) => p.type === 'text')
            .map((p) => (p as any).text)
            .join('\n') || `tool_failed:${definition.name}`,
        );
      return {
        content: result.content.map((part) =>
          part.type === 'image'
            ? {
                type: 'image' as const,
                data: part.data,
                mimeType: part.mimeType,
              }
            : {
                type: 'text' as const,
                text: part.type === 'text' ? part.text : JSON.stringify(part),
              },
        ),
        details: { toolCallId },
      };
    },
  };
}

export function guardPiTools(
  tools: AgentTool<any>[],
  policy: RuntimeToolPolicy,
): AgentTool<any>[] {
  const effectivePolicy = {
    ...policy,
    defaultDecision:
      policy.defaultDecision ??
      (policy.allowedTools !== undefined ? 'deny' : undefined),
  };
  return tools.map((tool) => ({
    ...tool,
    execute: async (id, params, signal, onUpdate) => {
      signal?.throwIfAborted();
      const outcome = await executeGuardedRuntimeTool({
        toolName: tool.name,
        toolUseId: id,
        input: params,
        policy: effectivePolicy,
        handler: (input) => tool.execute(id, input, signal, onUpdate),
      });
      if (!outcome.ok) throw Error(outcome.error);
      return outcome.result;
    },
  }));
}

export function inProcessServerTools(
  servers: Record<string, unknown> | undefined,
): AgentTool<any>[] {
  return Object.values(servers ?? {}).flatMap((value) => {
    const server = value as InProcessToolServer;
    if (!server || server.type !== 'in-process' || !Array.isArray(server.tools))
      throw Error('host_tool_server_invalid');
    return server.tools.map(adaptRuntimeToolDefinition);
  });
}
