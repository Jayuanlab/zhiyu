import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { AgentOptions } from '@openzhiyu/ai/agent/types';
import { loadMcpServers } from '../mcp/loader';

/** MCP is a protocol client of the Pi host. Only locally configured servers and
 * explicitly selected tools are connected; provider keys are never inherited. */
export async function openPiMcpTools(
  options: AgentOptions,
): Promise<{ tools: AgentTool<any>[]; close: () => Promise<void> }> {
  const clients: Client[] = [];
  const pendingCloses:Promise<void>[]=[];
  const close = async () => {
    const results = await Promise.allSettled(
      [...pendingCloses,...clients.map((client) => client.close())],
    );
    if (results.some((result) => result.status === 'rejected'))
      throw Error('mcp_cleanup_unconfirmed');
  };
  if (!options.mcpConfig?.enabled) return { tools: [], close };
  const servers = await loadMcpServers(options.mcpConfig);
  const allowed = new Set(options.allowedTools ?? []),
    excluded = new Set(options.excludeTools ?? []);
  const tools: AgentTool<any>[] = [];
  try {
    const selected = Object.entries(servers).filter(([name]) =>
      [...allowed].some((tool) => tool.startsWith(`mcp__${name}__`)),
    );
    if (selected.length > 10) throw Error('mcp_server_limit');
    for (const [name, server] of selected) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
        throw Error('mcp_server_name_invalid');
      const client = new Client(
        { name: 'zhiyu-pi-host', version: '1.0.0' },
        { capabilities: {} },
      );
      clients.push(client);
      const signal = options.abortController?.signal;
      signal?.throwIfAborted();
      let transport;
      if ('command' in server) {
        const env: Record<string, string> = {};
        for (const key of [
          'PATH',
          'Path',
          'SystemRoot',
          'WINDIR',
          'TEMP',
          'TMP',
          'PATHEXT',
        ])
          if (process.env[key]) env[key] = process.env[key]!;
        transport = new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: { ...env, ...server.env },
          stderr: 'pipe',
        });
      } else {
        const url = new URL(server.url);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw Error('mcp_server_url_invalid');
        const requestInit = {
          headers: server.headers,
          redirect: 'error' as const,
        };
        transport =
          server.type === 'sse'
            ? new SSEClientTransport(url, { requestInit })
            : new StreamableHTTPClientTransport(url, { requestInit });
      }
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {const closing=client.close();pendingCloses.push(closing);void closing.catch(()=>{});};
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await Promise.race([
          client.connect(transport),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(Error('mcp_connect_timeout')),
              10000,
            );
          }),
        ]);
      } finally {
        if (deadline) clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
      }
      const definitions = await client.listTools(undefined, {
        signal,
        timeout: 10000,
      });
      for (const definition of definitions.tools) {
        const toolName = `mcp__${name}__${definition.name}`;
        if (
          !allowed.has(toolName) ||
          excluded.has(toolName) ||
          excluded.has(definition.name)
        )
          continue;
        if (tools.length >= 100) throw Error('mcp_tool_limit');
        tools.push({
          name: toolName,
          label: toolName,
          description: definition.description ?? definition.name,
          parameters: Type.Unsafe(definition.inputSchema),
          replay: 'never',
          executionMode: 'sequential',
          execute: async (_id, params, abortSignal) => {
            abortSignal?.throwIfAborted();
            if (
              definition.annotations?.readOnlyHint !== true &&
              !options.onPermissionRequest
            )
              throw Error('mcp_write_requires_host_approval');
            const result = await client.callTool(
              {
                name: definition.name,
                arguments: params as Record<string, unknown>,
              },
              undefined,
              { signal: abortSignal, timeout: 60000 },
            );
            if (result.isError) throw Error('mcp_tool_failed');
            return {
              content: (result.content as any[]).map((part) =>
                part.type === 'image'
                  ? {
                      type: 'image' as const,
                      data: part.data,
                      mimeType: part.mimeType,
                    }
                  : {
                      type: 'text' as const,
                      text:
                        part.type === 'text' ? part.text : JSON.stringify(part),
                    },
              ),
              details: { server: name, tool: definition.name },
            };
          },
        });
      }
    }
    return { tools, close };
  } catch (error) {
    await close();
    throw error;
  }
}
