import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { decryptPayload, encryptPayload } from '@/lib/db/serialization';
import {
  ModelCenterError,
  modelCenterDocumentSchema,
  validateModelCenterDocument,
  type ModelCenterSnapshot,
  type ModelCenterDocument,
} from '@openzhiyu/shared/model-center';
import { modelConnectionBaseUrl } from '@openzhiyu/shared/model-configuration';

function rows(value: any): any[] {
  return value.rows ?? value;
}
function snapshot(row: any): ModelCenterSnapshot {
  const secrets = decryptPayload<Record<string, string>>(row.secrets_encrypted);
  if (!secrets || typeof secrets !== 'object')
    throw new ModelCenterError(
      'configuration_decryption_failed',
      undefined,
      500,
    );
  return {
    revision: row.revision,
    document: row.document,
    secrets,
    updatedAt: new Date(row.created_at).toISOString(),
  };
}
export async function readModelCenterSnapshot(
  userId: string,
): Promise<ModelCenterSnapshot | null> {
  const result = rows(
    await db.execute(sql`SELECT v.* FROM user_model_center_heads h JOIN user_model_center_versions v
    ON h.user_id=v.user_id AND h.revision=v.revision WHERE h.user_id=${userId}::uuid`),
  );
  return result[0] ? snapshot(result[0]) : null;
}
export async function modelCenterHistory(userId: string) {
  return rows(
    await db.execute(sql`SELECT revision, action, restored_from AS "restoredFrom",created_at AS "createdAt",
    jsonb_array_length(document->'connections') AS "connectionCount" FROM user_model_center_versions
    WHERE user_id=${userId}::uuid ORDER BY revision DESC LIMIT 50`),
  );
}

export async function readModelCenterVersion(
  userId: string,
  revision: number,
): Promise<ModelCenterSnapshot> {
  const result = rows(
    await db.execute(
      sql`SELECT * FROM user_model_center_versions WHERE user_id=${userId}::uuid AND revision=${revision}`,
    ),
  );
  if (!result[0])
    throw new ModelCenterError('revision_not_found', undefined, 404);
  return snapshot(result[0]);
}

export async function saveModelCenterSnapshot(input: {
  userId: string;
  expectedRevision: number;
  document: unknown;
  secretUpdates?: Record<string, string | null>;
  initialSecrets?: Record<string, string>;
  initialDocument?: ModelCenterDocument;
  action?: 'save' | 'rollback' | 'compatibility';
  restoreRevision?: number;
}) {
  return db.transaction(async (tx: any) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'model-center:' + input.userId},0))`,
    );
    const currentRow = rows(
      await tx.execute(sql`SELECT v.* FROM user_model_center_heads h JOIN user_model_center_versions v
      ON h.user_id=v.user_id AND h.revision=v.revision WHERE h.user_id=${input.userId}::uuid`),
    )[0];
    const current = currentRow ? snapshot(currentRow) : null;
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw new ModelCenterError('configuration_conflict', undefined, 409);
    let document = input.document;
    let secrets = { ...(current?.secrets ?? input.initialSecrets ?? {}) };
    if (input.restoreRevision) {
      const previous = rows(
        await tx.execute(
          sql`SELECT * FROM user_model_center_versions WHERE user_id=${input.userId}::uuid AND revision=${input.restoreRevision}`,
        ),
      )[0];
      if (!previous)
        throw new ModelCenterError('revision_not_found', undefined, 404);
      const restored = snapshot(previous);
      document = restored.document;
      secrets = restored.secrets;
    } else {
      for (const [id, key] of Object.entries(input.secretUpdates ?? {})) {
        if (key === null) delete secrets[id];
        else if (key.trim()) secrets[id] = key.trim();
      }
      const next = modelCenterDocumentSchema.parse(document);
      for (const item of next.connections ?? []) {
        const old = (
          current?.document ?? input.initialDocument
        )?.connections.find((connection) => connection.id === item.id);
        const update = input.secretUpdates?.[item.id],
          replaced = update === null || Boolean(update?.trim());
        if (
          old &&
          secrets[item.id] &&
          old.baseUrl &&
          item.baseUrl &&
          !replaced &&
          (old.protocol !== item.protocol ||
            modelConnectionBaseUrl(old.baseUrl, old.protocol) !==
              modelConnectionBaseUrl(item.baseUrl, item.protocol))
        )
          throw new ModelCenterError('host_change_requires_key', item.name);
      }
    }
    const normalized = validateModelCenterDocument(document, secrets);
    secrets = Object.fromEntries(
      normalized.connections
        .filter((item) => secrets[item.id])
        .map((item) => [item.id, secrets[item.id]]),
    );
    const revision = (current?.revision ?? 0) + 1;
    const encrypted = encryptPayload(secrets);
    await tx.execute(sql`INSERT INTO user_model_center_versions(user_id,revision,document,secrets_encrypted,action,restored_from)
      VALUES (${input.userId}::uuid,${revision},${JSON.stringify(normalized)}::jsonb,${encrypted},${input.action ?? 'save'},${input.restoreRevision ?? null})`);
    await tx.execute(sql`INSERT INTO user_model_center_heads(user_id,revision) VALUES (${input.userId}::uuid,${revision})
      ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,updated_at=clock_timestamp()`);
    return {
      revision,
      document: normalized,
      secrets,
      updatedAt: new Date().toISOString(),
    } as ModelCenterSnapshot;
  });
}

export async function recentModelTests(userId: string) {
  return rows(
    await db.execute(sql`SELECT connection_id AS "connectionId",revision,model,capability,passed,detail,duration_ms AS "durationMs",created_at AS "createdAt"
    FROM user_model_connection_tests WHERE user_id=${userId}::uuid ORDER BY created_at DESC LIMIT 60`),
  );
}
export async function recordModelTest(input: {
  userId: string;
  connectionId: string;
  revision: number;
  model: string;
  capability: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}) {
  await db.execute(sql`INSERT INTO user_model_connection_tests(user_id,connection_id,revision,model,capability,passed,detail,duration_ms)
    VALUES (${input.userId}::uuid,${input.connectionId},${input.revision},${input.model},${input.capability},${input.passed},${input.detail},${input.durationMs})`);
}
