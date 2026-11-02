import { z } from 'zod';
import {
  MODEL_PURPOSES,
  modelConnectionBaseUrl,
  resolveModelConfiguration,
  hasExplicitPurposeConnection,
  configuredText,
  MODEL_PROTOCOLS,
  type ModelProtocol,
  type ModelPurpose,
  type ModelConfiguration,
  type ModelEnvironment,
  type UserModelConnections,
} from './model-configuration';

export const MODEL_TIERS = [
  'cheap',
  'standard',
  'review',
  'audit',
  'vision',
] as const;
export const modelConnectionSchema = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,80}$/)
    .refine(
      (id) =>
        ![
          '__proto__',
          'constructor',
          'prototype',
          'inherit',
          'disabled',
        ].includes(id),
    ),
  name: z.string().trim().min(1).max(100),
  protocol: z.enum(MODEL_PROTOCOLS),
  baseUrl: z.string().trim().max(2048),
  model: z.string().trim().max(256),
  enabled: z.boolean(),
});
export const modelAssignmentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }),
  z.object({ mode: z.literal('disabled') }),
  z.object({
    mode: z.literal('connection'),
    connectionId: z.string().min(1),
    model: z.string().trim().max(256).optional(),
  }),
]);
export const modelCenterDocumentSchema = z.object({
  connections: z.array(modelConnectionSchema).max(40),
  defaults: z.object({
    openai_compatible: z.string().nullable(),
    openai_responses: z.string().nullable().optional(),
    anthropic_compatible: z.string().nullable(),
  }),
  defaultConnectionId: z.string().nullable().optional(),
  conversationProtocol: z
    .enum([
      'auto',
      'openai_compatible',
      'openai_responses',
      'anthropic_compatible',
    ])
    .default('auto'),
  assignments: z.record(z.string(), modelAssignmentSchema),
});
export type ModelCenterDocument = z.infer<typeof modelCenterDocumentSchema>;
export type ModelCenterConnection = z.infer<typeof modelConnectionSchema>;
export type ModelAssignment = z.infer<typeof modelAssignmentSchema>;
export type ModelCenterSnapshot = {
  revision: number;
  document: ModelCenterDocument;
  secrets: Record<string, string>;
  updatedAt: string;
};
export type SafeModelCenterSnapshot = Omit<ModelCenterSnapshot, 'secrets'> & {
  connections: Array<ModelCenterConnection & { hasApiKey: boolean }>;
};

export class ModelCenterError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail?: string,
    public readonly status = 400,
  ) {
    super(code);
    this.name = 'ModelCenterError';
  }
}
export function assignmentKey(purpose: ModelPurpose, tier?: string) {
  return purpose === 'agent' && tier ? `agent:${tier}` : purpose;
}
export function assignmentProtocols(key: string): readonly ModelProtocol[] {
  if (key.startsWith('agent:') && MODEL_TIERS.includes(key.slice(6) as any))
    return MODEL_PROTOCOLS;
  const spec = Object.hasOwn(MODEL_PURPOSES, key)
    ? MODEL_PURPOSES[key as ModelPurpose]
    : undefined;
  if (!spec) throw new ModelCenterError('unknown_model_purpose', key);
  return spec.protocols;
}

export function validateModelCenterDocument(
  raw: unknown,
  secrets: Record<string, string>,
) {
  const document = modelCenterDocumentSchema.parse(raw);
  const ids = new Set<string>();
  for (const connection of document.connections) {
    if (ids.has(connection.id))
      throw new ModelCenterError('duplicate_connection', connection.id);
    ids.add(connection.id);
    if (connection.enabled) {
      if (
        !connection.baseUrl ||
        !connection.model ||
        !secrets[connection.id]?.trim()
      )
        throw new ModelCenterError('connection_incomplete', connection.id);
      connection.baseUrl = modelConnectionBaseUrl(
        connection.baseUrl,
        connection.protocol,
      );
    }
  }
  for (const [protocol, id] of Object.entries(document.defaults)) {
    if (!id) continue;
    const connection = document.connections.find((item) => item.id === id);
    if (!connection || connection.protocol !== protocol)
      throw new ModelCenterError('default_protocol_mismatch', protocol);
  }
  if (document.defaultConnectionId && !ids.has(document.defaultConnectionId))
    throw new ModelCenterError('assignment_connection_missing', 'default');
  for (const [key, assignment] of Object.entries(document.assignments)) {
    const protocols = assignmentProtocols(key);
    if (assignment.mode !== 'connection') continue;
    const connection = document.connections.find(
      (item) => item.id === assignment.connectionId,
    );
    if (!connection)
      throw new ModelCenterError('assignment_connection_missing', key);
    if (!protocols.includes(connection.protocol))
      throw new ModelCenterError('assignment_protocol_mismatch', key);
  }
  return document;
}

export function selectCenterConnection(
  snapshot: ModelCenterSnapshot,
  id: string,
  purpose: ModelPurpose,
  model?: string,
): ModelConfiguration {
  const item = snapshot.document.connections.find(
    (connection) => connection.id === id,
  );
  if (!item)
    throw new ModelCenterError('assignment_connection_missing', purpose);
  if (!item.enabled)
    throw new ModelCenterError('model_connection_disabled', item.name);
  const apiKey = snapshot.secrets[id];
  if (!apiKey || !item.baseUrl || !item.model)
    throw new ModelCenterError('connection_incomplete', item.name);
  return Object.freeze({
    apiKey,
    baseUrl: modelConnectionBaseUrl(item.baseUrl, item.protocol),
    model: model?.trim() || item.model,
    protocol: item.protocol,
    purpose,
    revision: `center:${snapshot.revision}`,
    source: `connection:${item.name}`,
    connectionId: item.id,
    connectionName: item.name,
  });
}

export function resolveCenterModelConfiguration(
  snapshot: ModelCenterSnapshot,
  input: {
    purpose: ModelPurpose;
    tier?: string;
    modelOverride?: string;
    env: ModelEnvironment;
  },
) {
  const assignment = selectCenterAssignment(
    snapshot,
    input.purpose,
    input.tier,
  );
  if (assignment)
    return Object.freeze({
      ...assignment,
      model:
        input.modelOverride &&
        !['default', 'chat-model'].includes(input.modelOverride)
          ? input.modelOverride
          : assignment.model,
    });
  if (hasExplicitPurposeConnection(input.purpose, input.env, input.tier))
    return resolveModelConfiguration(input);
  if (snapshot.document.defaultConnectionId && input.purpose !== 'image') {
    const selected = selectCenterConnection(
      snapshot,
      snapshot.document.defaultConnectionId,
      input.purpose,
    );
    const config = resolveModelConfiguration({
      ...input,
      users: { [selected.protocol]: selected },
    })!;
    return Object.freeze({
      ...config,
      source: config.source.replace(
        `user:${selected.protocol}`,
        `connection:${selected.connectionName}`,
      ),
      connectionId: selected.connectionId,
      connectionName: selected.connectionName,
    });
  }
  const users: UserModelConnections = {};
  for (const protocol of MODEL_PURPOSES[input.purpose].protocols) {
    const id = snapshot.document.defaults[protocol];
    if (id) {
      users[protocol] = selectCenterConnection(snapshot, id, input.purpose);
      break;
    }
  }
  const config = resolveModelConfiguration({ ...input, users });
  if (!config) return undefined;
  const selected = users[config.protocol] as ModelConfiguration | undefined;
  return config.source.includes('user:') && selected
    ? Object.freeze({
        ...config,
        source: `user:${selected.connectionName}`,
        connectionId: selected.connectionId,
        connectionName: selected.connectionName,
      })
    : config;
}

export function resolveCenterConversationConfiguration(
  snapshot: ModelCenterSnapshot,
  env: ModelEnvironment,
  modelOverride?: string,
) {
  return resolveCenterModelConfiguration(snapshot, {
    purpose: 'agent',
    env,
    modelOverride,
  });
}

/** null means no explicit binding; a disabled binding is a denial, never inheritance. */
export function selectCenterAssignment(
  snapshot: ModelCenterSnapshot,
  purpose: ModelPurpose,
  tier?: string,
): ModelConfiguration | null {
  if (snapshot.document.assignments[purpose]?.mode === 'disabled')
    throw new ModelCenterError('model_purpose_disabled', purpose);
  const key = assignmentKey(purpose, tier);
  let assignment = snapshot.document.assignments[key];
  if (
    (!assignment || assignment.mode === 'inherit') &&
    purpose === 'agent' &&
    tier
  )
    assignment = snapshot.document.assignments.agent;
  if (!assignment || assignment.mode === 'inherit') return null;
  if (assignment.mode === 'disabled')
    throw new ModelCenterError('model_purpose_disabled', key);
  return selectCenterConnection(
    snapshot,
    assignment.connectionId,
    purpose,
    assignment.model,
  );
}

export function safeModelCenterSnapshot(
  snapshot: ModelCenterSnapshot,
): SafeModelCenterSnapshot {
  const { secrets, ...rest } = snapshot;
  return {
    ...rest,
    connections: snapshot.document.connections.map((item) => ({
      ...item,
      hasApiKey: Boolean(secrets[item.id]),
    })),
  };
}

export const EMPTY_MODEL_CENTER_DOCUMENT: ModelCenterDocument = {
  connections: [],
  defaults: {
    openai_compatible: null,
    openai_responses: null,
    anthropic_compatible: null,
  },
  defaultConnectionId: null,
  conversationProtocol: 'auto',
  assignments: {},
};
