/** Complete connection policy shared by Web, Pi workers and configuration diagnostics. */
export const MODEL_PROTOCOLS = [
  'openai_compatible',
  'openai_responses',
  'anthropic_compatible',
] as const;
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];
export type PiProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages';
export type ModelPurpose =
  | 'text'
  | 'agent'
  | 'conversation_compaction'
  | 'workshop_planner'
  | 'loop_parser'
  | 'interaction_processor'
  | 'recall_planner'
  | 'report_evaluator'
  | 'loop_checker'
  | 'vision'
  | 'image';
export type ModelEnvironment = Readonly<Record<string, string | undefined>>;
export type ModelConnection = Readonly<{
  apiKey: string;
  baseUrl: string;
  model: string;
  revision?: string;
}>;
export type ModelConfiguration = ModelConnection &
  Readonly<{
    purpose: ModelPurpose;
    protocol: ModelProtocol;
    source: string;
    connectionId?: string;
    connectionName?: string;
    configuredBaseUrl?: string;
    configuredProtocol?: ModelProtocol;
  }>;
export type UserModelConnections = Partial<
  Record<ModelProtocol, ModelConnection | null>
>;
const all = MODEL_PROTOCOLS;
export const MODEL_PURPOSES = {
  text: { label: '通用文本', protocols: all, prefixes: [] },
  agent: { label: 'Pi 智能体执行', protocols: all, prefixes: [] },
  conversation_compaction: {
    label: '对话压缩',
    protocols: all,
    prefixes: ['CONVERSATION_COMPACTION_LLM'],
  },
  workshop_planner: {
    label: '车间规划',
    protocols: all,
    prefixes: ['WORKSHOP_PLANNER_LLM'],
  },
  loop_parser: { label: '任务解析', protocols: all, prefixes: ['LOOP_NL_LLM'] },
  interaction_processor: {
    label: '记忆整理',
    protocols: all,
    prefixes: ['INTERACTION_PROCESSOR_LLM'],
  },
  recall_planner: {
    label: '记忆召回规划',
    protocols: all,
    prefixes: ['BRAIN_RECALL_PLANNER_LLM', 'MEMORY_RECALL_LLM'],
  },
  report_evaluator: {
    label: '报告评审',
    protocols: all,
    prefixes: ['REPORT_QUALITY_EVALUATOR_LLM'],
  },
  loop_checker: { label: '任务结果检查', protocols: all, prefixes: [] },
  vision: { label: '视觉理解', protocols: all, prefixes: [] },
  image: { label: '图像生成', protocols: ['openai_compatible'], prefixes: [] },
} as const;
export class ModelConfigurationError extends Error {
  constructor(
    public readonly code:
      | 'model_config_incomplete'
      | 'model_config_invalid_url'
      | 'model_protocol_mismatch'
      | 'model_config_host_change_requires_key'
      | 'model_config_conflict'
      | 'model_connection_override_denied',
    public readonly source: string,
  ) {
    super(`${code}: ${source}`);
    this.name = 'ModelConfigurationError';
  }
}
export function configuredText(value: string | null | undefined) {
  const text = value?.trim();
  return text && !['undefined', 'null'].includes(text) ? text : undefined;
}
export function modelProtocolToPi(protocol: ModelProtocol): PiProtocol {
  return protocol === 'anthropic_compatible'
    ? 'anthropic-messages'
    : protocol === 'openai_responses'
      ? 'openai-responses'
      : 'openai-completions';
}
export function piProtocolToModel(protocol: string): ModelProtocol {
  const value = normalizeModelProtocol(protocol);
  if (!value)
    throw new ModelConfigurationError('model_protocol_mismatch', 'protocol');
  return value;
}
export function normalizeModelProtocol(
  value: string | null | undefined,
): ModelProtocol | undefined {
  return value === 'openai-completions' || value === 'openai_compatible'
    ? 'openai_compatible'
    : value === 'openai-responses' || value === 'openai_responses'
      ? 'openai_responses'
      : value === 'anthropic-messages' || value === 'anthropic_compatible'
        ? 'anthropic_compatible'
        : undefined;
}
export function assertModelSelectionOnly(selection?: {
  apiKey?: string;
  baseUrl?: string;
}) {
  if (configuredText(selection?.apiKey) || configuredText(selection?.baseUrl))
    throw new ModelConfigurationError(
      'model_connection_override_denied',
      'task_selection',
    );
}
export function normalizeModelBaseUrl(
  value: string,
  source = 'connection',
): string {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error();
    return url
      .toString()
      .replace(/\/+$/, '')
      .replace(/\/(?:chat\/completions|messages|responses|embeddings)$/, '');
  } catch {
    throw new ModelConfigurationError('model_config_invalid_url', source);
  }
}
export function modelApiUrl(
  baseUrl: string,
  operation: 'chat/completions' | 'messages' | 'responses' | 'embeddings',
): string {
  const base = normalizeModelBaseUrl(baseUrl);
  if (operation === 'messages')
    return `${base.endsWith('/v1') ? base : `${base}/v1`}/${operation}`;
  const path = new URL(base).pathname.replace(/\/+$/, '');
  return `${!path || path.endsWith('/compatible-mode') ? `${base}/v1` : base}/${operation}`;
}
export function modelConnectionBaseUrl(
  baseUrl: string,
  protocol: ModelProtocol,
) {
  return protocol === 'anthropic_compatible'
    ? normalizeModelBaseUrl(baseUrl).replace(/\/v1$/, '')
    : modelApiUrl(
        baseUrl,
        protocol === 'openai_responses' ? 'responses' : 'chat/completions',
      ).replace(/\/(?:chat\/completions|responses)$/, '');
}
export function validateModelConnectionUpdate(input: {
  protocol?: ModelProtocol;
  previous?: {
    apiKey?: string | null;
    baseUrl?: string | null;
    model?: string | null;
    enabled: boolean;
  };
  next: {
    apiKey?: string | null;
    baseUrl?: string | null;
    model?: string | null;
    enabled?: boolean;
  };
}) {
  const { previous, next } = input,
    effective = {
      apiKey: next.apiKey === undefined ? previous?.apiKey : next.apiKey,
      baseUrl: next.baseUrl === undefined ? previous?.baseUrl : next.baseUrl,
      model: next.model === undefined ? previous?.model : next.model,
    };
  const normalize = (url: string) =>
      modelConnectionBaseUrl(url, input.protocol ?? 'openai_compatible'),
    base = effective.baseUrl ? normalize(effective.baseUrl) : effective.baseUrl;
  if (
    previous?.apiKey &&
    next.apiKey === undefined &&
    previous.baseUrl &&
    base &&
    normalize(previous.baseUrl) !== base
  )
    throw new ModelConfigurationError(
      'model_config_host_change_requires_key',
      'saved_connection',
    );
  if (next.enabled ?? previous?.enabled ?? false)
    connection(
      { ...effective, baseUrl: base } as ModelConnection,
      'saved_connection',
    );
  return base;
}
function connection(value: ModelConnection, source: string): ModelConnection {
  const apiKey = configuredText(value.apiKey),
    model = configuredText(value.model),
    baseUrl = configuredText(value.baseUrl);
  if (!apiKey || !model || !baseUrl)
    throw new ModelConfigurationError('model_config_incomplete', source);
  return Object.freeze({
    apiKey,
    model,
    baseUrl: normalizeModelBaseUrl(baseUrl, source),
    ...(value.revision ? { revision: value.revision } : {}),
  });
}
function envProfile(env: ModelEnvironment, prefix: string) {
  return {
    apiKey: configuredText(env[`${prefix}_API_KEY`]),
    baseUrl: configuredText(env[`${prefix}_BASE_URL`]),
    model: configuredText(env[`${prefix}_MODEL`]),
  };
}
function purposePrefixes(purpose: ModelPurpose, tier?: string) {
  const prefixes: string[] = [...MODEL_PURPOSES[purpose].prefixes];
  if (purpose === 'agent' && tier) {
    if (!['cheap', 'standard', 'review', 'audit', 'vision'].includes(tier))
      throw new ModelConfigurationError(
        'model_config_incomplete',
        'model_tier',
      );
    prefixes.unshift(
      `LLM_${tier.toUpperCase()}`,
      `ANTHROPIC_${tier.toUpperCase()}`,
    );
  }
  return prefixes;
}
function envProtocol(
  env: ModelEnvironment,
  prefix: string,
  fallback: ModelProtocol,
): ModelProtocol {
  const raw =
    configuredText(env[`${prefix}_PROTOCOL`]) ??
    configuredText(env[`${prefix}_PROVIDER`]) ??
    (prefix.startsWith('ANTHROPIC')
      ? 'anthropic_compatible'
      : (configuredText(env.LLM_API_PROTOCOL) ??
        configuredText(env.PI_AGENT_PROTOCOL)));
  const protocol = raw ? normalizeModelProtocol(raw) : fallback;
  if (!protocol)
    throw new ModelConfigurationError(
      'model_protocol_mismatch',
      `env:${prefix}`,
    );
  return protocol;
}
export function hasExplicitPurposeConnection(
  purpose: ModelPurpose,
  env: ModelEnvironment,
  tier?: string,
) {
  return purposePrefixes(purpose, tier).some((prefix) => {
    const value = envProfile(env, prefix);
    return Boolean(value.apiKey || value.baseUrl);
  });
}
export function resolveModelConfiguration(input: {
  purpose: ModelPurpose;
  env?: ModelEnvironment;
  users?: UserModelConnections;
  tier?: string;
  modelOverride?: string;
}): ModelConfiguration | undefined {
  const env = input.env ?? {},
    protocols: readonly ModelProtocol[] =
      MODEL_PURPOSES[input.purpose].protocols;
  let override = configuredText(input.modelOverride),
    overrideSource = override ? 'task_model' : undefined;
  if (override === 'default' || override === 'chat-model') {
    override = undefined;
    overrideSource = undefined;
  }
  if (!override && ['vision', 'image'].includes(input.purpose)) {
    const key =
      input.purpose === 'vision'
        ? 'LLM_VISION_LANGUAGE_MODEL'
        : 'LLM_IMAGE_MODEL';
    override = configuredText(env[key]);
    if (override) overrideSource = `env:${key}`;
    if (input.purpose === 'image' && !override) return undefined;
  }
  const finish = (
    value: ModelConnection,
    protocol: ModelProtocol,
    source: string,
  ): ModelConfiguration => {
    if (!protocols.includes(protocol))
      throw new ModelConfigurationError('model_protocol_mismatch', source);
    return Object.freeze({
      ...connection(value, source),
      baseUrl: modelConnectionBaseUrl(value.baseUrl, protocol),
      ...(override ? { model: override } : {}),
      purpose: input.purpose,
      protocol,
      source: overrideSource ? `${overrideSource} > ${source}` : source,
    });
  };
  for (const prefix of purposePrefixes(input.purpose, input.tier)) {
    const value = envProfile(env, prefix);
    if (!value.apiKey && !value.baseUrl && !value.model) continue;
    if (!value.apiKey && !value.baseUrl) {
      if (!override) {
        override = value.model;
        overrideSource = `env:${prefix}_MODEL`;
      }
      continue;
    }
    return finish(
      connection(value as ModelConnection, `env:${prefix}`),
      envProtocol(env, prefix, protocols[0]),
      `env:${prefix}`,
    );
  }
  for (const protocol of protocols) {
    const user = input.users?.[protocol];
    if (user) return finish(user, protocol, `user:${protocol}`);
  }
  for (const prefix of ['LLM', 'ANTHROPIC']) {
    const value = envProfile(env, prefix);
    if (prefix === 'ANTHROPIC') {
      value.apiKey ??= configuredText(env.ANTHROPIC_AUTH_TOKEN);
      if (value.apiKey && !value.baseUrl)
        value.baseUrl = 'https://api.anthropic.com';
    }
    if (!value.apiKey && !value.baseUrl && !value.model) continue;
    return finish(
      connection(value as ModelConnection, `env:${prefix}`),
      envProtocol(
        env,
        prefix,
        prefix === 'ANTHROPIC' ? 'anthropic_compatible' : 'openai_compatible',
      ),
      `env:${prefix}`,
    );
  }
  if (override)
    throw new ModelConfigurationError(
      'model_config_incomplete',
      overrideSource ?? input.purpose,
    );
  return undefined;
}
export function describeModelConfiguration(
  config: ModelConfiguration | undefined,
) {
  return config
    ? {
        configured: true,
        purpose: config.purpose,
        protocol: config.protocol,
        source: config.source,
        revision: config.revision ?? 'deployment',
        baseUrl: config.baseUrl,
        model: config.model,
        hasApiKey: true,
        connectionId: config.connectionId,
        connectionName: config.connectionName,
        configuredBaseUrl: config.configuredBaseUrl,
        configuredProtocol: config.configuredProtocol,
      }
    : { configured: false };
}
