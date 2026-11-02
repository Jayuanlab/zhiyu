import { getUserLlmApiSettingWithApiKey } from '@/lib/db/llm-api-settings-queries';
import {
  readModelCenterSnapshot,
  modelCenterHistory,
  recentModelTests,
} from './model-center-store';
import { describeEffectiveModelConfigurations } from './model-configuration';
import {
  EMPTY_MODEL_CENTER_DOCUMENT,
  ModelCenterError,
  safeModelCenterSnapshot,
  type ModelCenterSnapshot,
} from '@openzhiyu/shared/model-center';
import { ModelConfigurationError } from '@openzhiyu/shared/model-configuration';
import { ZodError } from 'zod';

/** Import is virtual until the first atomic save. Existing credentials stay private. */
export async function getModelCenterSnapshot(
  userId: string,
): Promise<ModelCenterSnapshot> {
  const saved = await readModelCenterSnapshot(userId);
  if (saved) return saved;
  const document = structuredClone(EMPTY_MODEL_CENTER_DOCUMENT),
    secrets: Record<string, string> = {};
  for (const protocol of [
    'openai_compatible',
    'anthropic_compatible',
  ] as const) {
    const old = await getUserLlmApiSettingWithApiKey({
      userId,
      providerType: protocol,
    });
    if (!old) continue;
    const id = `imported_${protocol}`;
    document.connections.push({
      id,
      name:
        protocol === 'openai_compatible' ? '原有文本服务' : '原有智能体服务',
      protocol,
      baseUrl: old.baseUrl ?? '',
      model: old.model ?? '',
      enabled: old.enabled,
    });
    if (old.apiKey) secrets[id] = old.apiKey;
    if (old.enabled) document.defaults[protocol] = id;
  }
  document.defaultConnectionId=document.connections.find(connection=>connection.enabled)?.id ?? null;
  return { revision: 0, document, secrets, updatedAt: '' };
}
export async function getModelCenterResponse(userId: string) {
  const snapshot = await getModelCenterSnapshot(userId);
  const [effective, history, tests] = await Promise.all([
    describeEffectiveModelConfigurations(
      userId,
      snapshot.revision ? snapshot : undefined,
    ),
    modelCenterHistory(userId),
    recentModelTests(userId),
  ]);
  return {
    ...safeModelCenterSnapshot(snapshot),
    effective,
    history,
    tests,
    observedAt: new Date().toISOString(),
  };
}
export function modelCenterErrorResponse(error: unknown) {
  if (error instanceof ModelCenterError)
    return Response.json(
      { error: error.code, detail: error.detail },
      { status: error.status },
    );
  if (error instanceof ModelConfigurationError)
    return Response.json({ error: error.code }, { status: 400 });
  if (error instanceof ZodError)
    return Response.json(
      {
        error: 'invalid_configuration',
        fields: error.issues.map((item) => item.path.join('.')),
      },
      { status: 400 },
    );
  if (error instanceof SyntaxError)
    return Response.json({ error: 'invalid_configuration' }, { status: 400 });
  // Do not return SQL, decrypted payloads, or provider errors containing secrets.
  console.error(
    '[Model center] operation failed',
    error instanceof Error ? error.name : 'unknown',
  );
  return Response.json({ error: 'model_center_unavailable' }, { status: 500 });
}
