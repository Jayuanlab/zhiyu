import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentConfig, AgentOptions } from '@openzhiyu/ai/agent/types';
import {
  createPiAgentRuntime,
  createPiRuntimeOptionsFromModelConfig,
} from '@openzhiyu/ai/agent/runtime';
import { loadSkills, getSkillContent } from '../skills/loader';
import { readSkillReference } from '../skills/resource-reader';

export function createPiTaskTool(input: {
  config: AgentConfig;
  options: AgentOptions;
  tools: () => AgentTool<any>[];
  systemPrompt?: string;
}): AgentTool<any> {
  let active = false;
  return {
    name: 'Task',
    label: 'Task',
    description:
      'Delegate one bounded read-only subtask using the same model connection, role and host permissions. Child tasks cannot delegate, write business state, request new authority or complete the parent task.',
    parameters: Type.Object({
      prompt: Type.String(),
      description: Type.Optional(Type.String()),
      subagent_type: Type.Optional(Type.String()),
    }),
    replay: 'never',
    executionMode: 'sequential',
    execute: async (_id, params: any, signal) => {
      if (active) throw Error('pi_subtask_already_running');
      active = true;
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(abort, 60000);
      try {
        signal?.throwIfAborted();
        const readonly = new Set([
          'time',
          'webSearch',
          'webReadPage',
          'Read',
          'Glob',
          'Grep',
          'Skill',
          'askMemory',
          'searchKnowledgeBase',
          'getFullDocumentContent',
          'listKnowledgeBaseDocuments',
          'searchUnifiedMemory',
          'searchMemoryPath',
          'chatInsight',
          'queryContacts',
          'brainListMemories',
          'brainListCandidates',
          'brainListSnapshots',
          'brainListGrants',
        ]);
        const prefix = `subtask:${_id}:`;
        const childTools = input
          .tools()
          .filter((tool) => readonly.has(tool.name))
          .map((tool) => ({
            ...tool,
            execute: (
              id: string,
              args: unknown,
              childSignal?: AbortSignal,
              update?: any,
            ) => tool.execute(prefix + id, args, childSignal, update),
          }));
        const runtime = createPiAgentRuntime({
          ...createPiRuntimeOptionsFromModelConfig({
            apiKey: input.config.apiKey,
            baseUrl: input.config.baseUrl,
            model: input.config.model ?? '',
            protocol: input.config.providerConfig?.protocol as any,
          }),
          tools: childTools,
          systemPrompt: input.systemPrompt,
          streamOptions: { timeoutMs: 60000 },
        });
        let result = '',
          completed = false,
          done = false,
          failed = false,
          calls = 0;
        for await (const message of runtime.run({
          operation: 'run',
          prompt: String(params.prompt),
          options: {
            ...input.options,
            abortController: controller,
            onBeforeToolUse: async (event) => {
              if (++calls > 8) throw Error('pi_subtask_tool_budget');
              await input.options.onBeforeToolUse?.({
                ...event,
                toolUseId: prefix + event.toolUseId,
              });
            },
            onPermissionRequest: input.options.onPermissionRequest
              ? (event) =>
                  input.options.onPermissionRequest!({
                    ...event,
                    toolUseID: prefix + event.toolUseID,
                  })
              : undefined,
            hostFinalValidation: undefined,
            hostWorkingMemory: undefined,
            hostReportReserve: undefined,
            hostProviderRecovery: undefined,
          },
        })) {
          if (
            message.type === 'result' &&
            message.answerPhase !== 'intermediate'
          )
            result = message.content ?? '';
          if (message.type === 'runtime_terminal')
            completed =
              message.runtimeTerminal?.status === 'completed' &&
              message.runtimeTerminal.cleanupStatus === 'completed';
          if (message.type === 'done') done = true;
          if (message.type === 'error') failed = true;
        }
        if (failed || !completed || !done || !result.trim())
          throw Error('pi_subtask_unconfirmed');
        return {
          content: [{ type: 'text', text: result }],
          details: {
            engine: 'pi',
            model: input.config.model,
            tools: calls,
            scope: 'read_only_subtask',
            parentCompletion: false,
          },
        };
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        active = false;
      }
    },
  };
}

export function createPiTodoTool(): AgentTool<any> {
  let todos: unknown[] = [];
  return {
    name: 'TodoWrite',
    label: 'TodoWrite',
    description:
      'Maintain structured run-local progress. These notes do not complete a Work, Loop or business action.',
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String(),
          status: Type.Union([
            Type.Literal('pending'),
            Type.Literal('in_progress'),
            Type.Literal('completed'),
          ]),
          activeForm: Type.Optional(Type.String()),
          id: Type.Optional(Type.String()),
          priority: Type.Optional(Type.String()),
        }),
        { maxItems: 100 },
      ),
    }),
    replay: 'never',
    executionMode: 'sequential',
    execute: async (_id, params: any) => {
      todos = structuredClone(params.todos);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              todos,
              scope: 'run_local',
              businessCompletion: false,
            }),
          },
        ],
        details: { todos, scope: 'run_local' },
      };
    },
  };
}

export function createPiSkillTool(): AgentTool<any> {
  return {
    name: 'Skill',
    label: 'Skill',
    description:
      'Read installed skill instructions or a bounded referenced resource. Guidance does not grant permissions.',
    parameters: Type.Object({
      skill: Type.String(),
      resource: Type.Optional(Type.String()),
    }),
    replay: 'never',
    executionMode: 'sequential',
    execute: async (_id, params: any, signal) => {
      signal?.throwIfAborted();
      const skill = loadSkills().find((item) => item.name === params.skill);
      if (!skill) throw Error('pi_skill_unavailable');
      const text = params.resource
        ? (await readSkillReference(skill.path, params.resource)).content
        : getSkillContent(skill.path);
      if (!text) throw Error('pi_skill_unavailable');
      signal?.throwIfAborted();
      return {
        content: [{ type: 'text', text }],
        details: { skill: skill.name, resource: params.resource ?? 'SKILL.md' },
      };
    },
  };
}
