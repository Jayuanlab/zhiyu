import { auth } from '@/app/(auth)/auth';
import { describeEffectiveModelConfigurations } from '@/lib/ai/model-configuration';
import { getUserLlmApiSettings } from '@/lib/db/llm-api-settings-queries';
import {
  getModelCenterSnapshot,
  modelCenterErrorResponse,
} from '@/lib/ai/model-center-service';
import { resolveModelConfiguration } from '@openzhiyu/shared/model-configuration';

/** Compatibility read surface. All writes go through the versioned model center. */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const snapshot = await getModelCenterSnapshot(session.user.id);
    const settings = snapshot.revision
      ? (['openai_compatible', 'anthropic_compatible'] as const).flatMap(
          (protocol) => {
            const item = snapshot.document.connections.find(
              (c) => c.id === snapshot.document.defaults[protocol],
            );
            return item
              ? [
                  {
                    providerType: protocol,
                    baseUrl: item.baseUrl,
                    model: item.model,
                    enabled: item.enabled,
                    hasApiKey: Boolean(snapshot.secrets[item.id]),
                  },
                ]
              : [];
          },
        )
      : await getUserLlmApiSettings(session.user.id);
    const systemDefaults = Object.fromEntries(
      (['openai_compatible', 'anthropic_compatible'] as const).map(
        (protocol) => {
          try {
            const config = resolveModelConfiguration({
              purpose: protocol === 'openai_compatible' ? 'text' : 'agent',
              env: { ...process.env },
            });
            return [
              protocol,
              {
                baseUrl: config?.baseUrl ?? null,
                model: config?.model ?? null,
                hasApiKey: Boolean(config),
              },
            ];
          } catch {
            return [protocol, { baseUrl: null, model: null, hasApiKey: false }];
          }
        },
      ),
    );
    return Response.json(
      {
        settings,
        systemDefaults,
        effective: await describeEffectiveModelConfigurations(
          session.user.id,
          snapshot.revision ? snapshot : undefined,
        ),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return modelCenterErrorResponse(error);
  }
}
async function moved() {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  return Response.json(
    {
      error: 'model_center_managed',
      url: '/?page=ai-api-settings',
      api: '/api/preferences/models',
    },
    { status: 409 },
  );
}
export const PUT = moved;
export const POST = moved;
export const DELETE = moved;
