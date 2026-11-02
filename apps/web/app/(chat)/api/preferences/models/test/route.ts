import { z } from 'zod';
import { auth } from '@/app/(auth)/auth';
import {
  ModelCenterError,
  modelConnectionSchema,
  selectCenterConnection,
} from '@openzhiyu/shared/model-center';
import { modelConnectionBaseUrl } from '@openzhiyu/shared/model-configuration';
import {
  getModelCenterSnapshot,
  modelCenterErrorResponse,
} from '@/lib/ai/model-center-service';
import { recordModelTest } from '@/lib/ai/model-center-store';
import { testModelConnection } from '@/lib/ai/model-connection-test';
const schema = z.object({
  revision: z.number().int().nonnegative(),
  connectionId: z.string(),
  draft: modelConnectionSchema.optional(),
  apiKey: z.string().max(4096).optional(),
});
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const payload = schema.parse(await request.json());
    const snapshot = await getModelCenterSnapshot(session.user.id);
    if (snapshot.revision !== payload.revision)
      throw new ModelCenterError('configuration_conflict', undefined, 409);
    let tested = snapshot;
    if (payload.draft) {
      if (payload.draft.id !== payload.connectionId)
        throw new ModelCenterError('invalid_configuration');
      const old = snapshot.document.connections.find(
        (c) => c.id === payload.connectionId,
      );
      if (
        old?.baseUrl &&
        snapshot.secrets[old.id] &&
        !payload.apiKey?.trim() &&
        (old.protocol !== payload.draft.protocol ||
          modelConnectionBaseUrl(old.baseUrl, old.protocol) !==
            modelConnectionBaseUrl(
              payload.draft.baseUrl,
              payload.draft.protocol,
            ))
      )
        throw new ModelCenterError('host_change_requires_key');
      tested = {
        ...snapshot,
        document: { ...snapshot.document, connections: [payload.draft] },
        secrets: {
          ...snapshot.secrets,
          ...(payload.apiKey?.trim()
            ? { [payload.connectionId]: payload.apiKey.trim() }
            : {}),
        },
      };
    }
    const config = selectCenterConnection(tested, payload.connectionId, 'text');
    const result = await testModelConnection(config);
    const persisted = !payload.draft && snapshot.revision > 0;
    if (persisted)
      await recordModelTest({
        userId: session.user.id,
        connectionId: payload.connectionId,
        revision: snapshot.revision,
        model: config.model,
        capability: 'text',
        ...result,
      });
    return Response.json({
      ...result,
      revision: snapshot.revision,
      model: config.model,
      persisted,
      testedAt: new Date().toISOString(),
    });
  } catch (error) {
    return modelCenterErrorResponse(error);
  }
}
