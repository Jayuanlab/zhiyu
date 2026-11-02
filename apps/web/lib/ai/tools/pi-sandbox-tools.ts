import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentOptions } from '@openzhiyu/ai/agent/types';
import { createSandboxProvider } from '@openzhiyu/ai/agent/sandbox';

/** A host-selected isolation provider, never an agent engine or a fallback to
 * host shell. The Web host continues to require separate sandbox admission. */
export async function openPiSandboxTools(options: AgentOptions) {
  const config = options.sandbox;
  if (!config?.enabled || !config.provider)
    throw Error('pi_sandbox_provider_required');
  if (!options.onPermissionRequest)
    throw Error('pi_sandbox_host_approval_required');
  const allowed = new Set(options.allowedTools ?? []);
  const names = ['sandbox_run_script', 'sandbox_run_command'].filter((name) =>
    allowed.has(name),
  );
  if (!names.length) throw Error('pi_sandbox_tools_not_allowed');
  const provider = createSandboxProvider({
    type: config.provider,
    name: String(config.provider),
    enabled:true,
    config: config.providerConfig??{},
  });
  const close = async () => {
    let failed=false;
    try{await provider.stop();}catch{failed=true;}
    try{await provider.shutdown();}catch{failed=true;}
    if(failed)throw Error('pi_resource_cleanup_unconfirmed');
  };
  try {
    options.abortController?.signal.throwIfAborted();
    if (!['container', 'vm'].includes(provider.getCapabilities().isolation))
      throw Error('pi_sandbox_isolation_required');
    if (!(await provider.isAvailable())) throw Error('pi_sandbox_unavailable');
    await provider.init(config.providerConfig);
    const tools: AgentTool<any>[] = names.map((name) => ({
      name,
      label: name,
      description:
        'Execute only in the explicitly selected isolated sandbox. Requires the current host permission decision; output is an execution receipt, not business completion.',
      parameters:
        name === 'sandbox_run_script'
          ? Type.Object({
              filePath: Type.String(),
              workDir: Type.String(),
              args: Type.Optional(Type.Array(Type.String())),
              timeout: Type.Optional(
                Type.Integer({ minimum: 1, maximum: 120000 }),
              ),
            })
          : Type.Object({
              command: Type.String(),
              args: Type.Optional(Type.Array(Type.String())),
              timeout: Type.Optional(
                Type.Integer({ minimum: 1, maximum: 120000 }),
              ),
            }),
      replay: 'never',
      executionMode: 'sequential',
      execute: async (_id, args: any, signal) => {
        signal?.throwIfAborted();
        let stopping: Promise<void> | undefined;
        const abort = () => {
          stopping = provider.stop();
          void stopping.catch(() => {});
        };
        signal?.addEventListener('abort', abort, { once: true });
        try {
          const result =
            name === 'sandbox_run_script'
              ? await provider.runScript(args.filePath, args.workDir, {
                  args: args.args,
                  timeout: args.timeout ?? 60000,
                  userId: options.session?.user?.id,
                })
              : await provider.exec({
                  command: args.command,
                  args: args.args,
                  timeout: args.timeout ?? 60000,
                  image: config.image,
                  userId: options.session?.user?.id,
                });
          signal?.throwIfAborted();
          if (result.exitCode !== 0) throw Error('pi_sandbox_execution_failed');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            details: {
              provider: provider.type,
              isolation: provider.getCapabilities().isolation,
              businessCompletion: false,
            },
          };
        } finally {
          signal?.removeEventListener('abort', abort);
          if (stopping) await stopping;
        }
      },
    }));
    return { tools, close };
  } catch (error) {
    await close();
    throw error;
  }
}
