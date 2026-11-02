import {
  MODEL_PURPOSES,
  hasExplicitPurposeConnection,
  resolveModelConfiguration,
  describeModelConfiguration,
  modelProtocolToPi,
  piProtocolToModel,
  type ModelPurpose,
  type ModelEnvironment,
  type ModelConfiguration,
  type UserModelConnections,
} from '@openzhiyu/shared/model-configuration';
import {
  resolveCenterModelConfiguration,
  resolveCenterConversationConfiguration,
  ModelCenterError,
  type ModelCenterSnapshot,
} from '@openzhiyu/shared/model-center';
import {
  resolveOpenCodeGoModelEndpoint,
  createPiLanguageModel,
} from '@openzhiyu/ai/agent/runtime';
import { getUserLlmProviderConfig } from './user-llm-api-settings';
import { readModelCenterSnapshot } from './model-center-store';

/** Keep diagnostics and the actual Pi serializer on the same endpoint identity. */
export function normalizePiModelConfiguration(
  config: ModelConfiguration | undefined,
): ModelConfiguration | undefined {
  if (!config) return undefined;
  const endpoint = resolveOpenCodeGoModelEndpoint({
    baseUrl: config.baseUrl,
    model: config.model,
    protocol: modelProtocolToPi(config.protocol),
  });
  if (!endpoint.migrated) return config;
  return Object.freeze({
    ...config,
    baseUrl: endpoint.baseUrl ?? config.baseUrl,
    protocol: endpoint.protocol
      ? piProtocolToModel(endpoint.protocol)
      : config.protocol,
    configuredBaseUrl: config.baseUrl,
    configuredProtocol: config.protocol,
  });
}
async function legacyConnections(
  userId: string,
): Promise<UserModelConnections> {
  const users: UserModelConnections = {};
  for (const providerType of [
    'openai_compatible',
    'anthropic_compatible',
  ] as const) {
    users[providerType] = await getUserLlmProviderConfig({
      userId,
      providerType,
    });
    if (users[providerType]) break;
  }
  return users;
}
export async function loadModelConfiguration(input: {
  userId: string;
  purpose: ModelPurpose;
  tier?: string;
  modelOverride?: string;
  env?: ModelEnvironment;
}) {
  const env = input.env ?? { ...process.env },
    center = await readModelCenterSnapshot(input.userId);
  if (center)
    return normalizePiModelConfiguration(
      resolveCenterModelConfiguration(center, { ...input, env }),
    );
  if (hasExplicitPurposeConnection(input.purpose, env, input.tier))
    return normalizePiModelConfiguration(
      resolveModelConfiguration({ ...input, env }),
    );
  const users = await legacyConnections(input.userId);
  return normalizePiModelConfiguration(
    resolveModelConfiguration({ ...input, env, users }),
  );
}
export async function requireModelConfiguration(
  input: Parameters<typeof loadModelConfiguration>[0],
) {
  const config = await loadModelConfiguration(input);
  if (!config) throw new Error(`model_not_configured: ${input.purpose}`);
  return config;
}
export async function loadConversationModelConfiguration(
  userId: string,
  modelOverride?: string,
) {
  return loadModelConfiguration({ userId, purpose: 'agent', modelOverride });
}
export function createTextModelFromConfiguration(config: ModelConfiguration) {
  return createPiLanguageModel({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    protocol: modelProtocolToPi(config.protocol),
  });
}
export async function createConfiguredTextModel(
  input: Parameters<typeof loadModelConfiguration>[0],
) {
  return createTextModelFromConfiguration(
    await requireModelConfiguration(input),
  );
}
export async function completeConfiguredText(
  config: ModelConfiguration,
  input: {
    system?: string;
    prompt?: string;
    messages?: any[];
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    json?: boolean;
  },
) {
  const { generateText } = await import('ai');
  const result = await generateText({
    model: createTextModelFromConfiguration(config),
    ...(input.system ? { system: input.system } : {}),
    ...(input.messages
      ? { messages: input.messages }
      : { prompt: input.prompt ?? '' }),
    maxOutputTokens: input.maxTokens,
    temperature: input.temperature,
    abortSignal: input.signal,
    maxRetries: 0,
    ...(input.json
      ? {
          system: [input.system, 'Return valid JSON only.']
            .filter(Boolean)
            .join('\n'),
        }
      : {}),
  });
  if (result.finishReason !== 'stop' || !result.text.trim())
    throw new Error('model_response_incomplete');
  return result;
}
export function modelConfigurationProvider(config: ModelConfiguration) {
  return {
    source: config.source,
    revision: config.revision,
    baseUrl: config.baseUrl,
    model: config.model,
    protocol: modelProtocolToPi(config.protocol),
    migrated: Boolean(config.configuredBaseUrl),
  };
}
export async function describeEffectiveModelConfigurations(
  userId: string,
  capturedSnapshot?: ModelCenterSnapshot,
) {
  const snapshot = capturedSnapshot ?? (await readModelCenterSnapshot(userId)),
    env = { ...process.env };
  const users = snapshot ? undefined : await legacyConnections(userId);
  const describe = (purpose: ModelPurpose, tier?: string) => {
    try {
      return describeModelConfiguration(
        normalizePiModelConfiguration(
          snapshot
            ? resolveCenterModelConfiguration(snapshot, { purpose, tier, env })
            : resolveModelConfiguration({ purpose, tier, env, users }),
        ),
      );
    } catch (error) {
      return {
        configured: false,
        error:
          error instanceof ModelCenterError
            ? error.code
            : error instanceof Error
              ? error.message.split(':')[0]
              : 'model_configuration_invalid',
      };
    }
  };
  return {
    ...Object.fromEntries(
      (Object.keys(MODEL_PURPOSES) as ModelPurpose[]).map((purpose) => [
        purpose,
        describe(purpose),
      ]),
    ),
    agent_tiers: Object.fromEntries(
      ['cheap', 'standard', 'review', 'audit', 'vision'].map((tier) => [
        tier,
        describe('agent', tier),
      ]),
    ),
    conversation: describe('agent'),
    engine: 'pi',
  };
}
