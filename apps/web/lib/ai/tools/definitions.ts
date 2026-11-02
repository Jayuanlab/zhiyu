import { z } from 'zod';
import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';

/** Host-owned business contracts. No agent process, credentials or transport. */
export type RuntimeToolDefinition<
  Schema extends z.ZodRawShape = z.ZodRawShape,
> = {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  handler: (
    args: z.output<z.ZodObject<Schema>>,
    extra: unknown,
  ) => Promise<CallToolResult>;
};

export function tool<Schema extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: RuntimeToolDefinition<Schema>['handler'],
  extras?: Pick<RuntimeToolDefinition<Schema>, 'annotations' | '_meta'>,
): RuntimeToolDefinition<Schema> {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name))
    throw Error('invalid_host_tool_name');
  return Object.freeze({ name, description, inputSchema, handler, ...extras });
}

export type InProcessToolServer = {
  type: 'in-process';
  name: string;
  version: string;
  tools: RuntimeToolDefinition<any>[];
};
/** Explicit host injection only. Pi invokes these handlers through its tool guard. */
export function createToolServer(
  input: Omit<InProcessToolServer, 'type'>,
): InProcessToolServer {
  const names = new Set<string>();
  for (const definition of input.tools) {
    if (names.has(definition.name)) throw Error('duplicate_host_tool');
    names.add(definition.name);
  }
  return { type: 'in-process', ...input };
}
