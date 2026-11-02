import { and, asc, eq } from 'drizzle-orm';
import { AppError } from '@openzhiyu/shared/errors';
import { generateUUID } from '@/lib/utils';
import { db } from './client';
import { type UserLlmApiSettings, userLlmApiSettings } from './schema';
import { decryptPayload, encryptPayload } from './serialization';
import { validateModelConnectionUpdate, ModelConfigurationError } from '@openzhiyu/shared/model-configuration';

export type LlmApiProviderType = UserLlmApiSettings['providerType'];

export type UserLlmApiSettingSafe = Omit<
  UserLlmApiSettings,
  'apiKeyEncrypted' | 'encryptionKeyId'
> & {
  hasApiKey: boolean;
};

export type UserLlmApiSettingWithApiKey = UserLlmApiSettingSafe & {
  apiKey: string | null;
};

export type UpsertUserLlmApiSettingInput = {
  userId: string;
  providerType: LlmApiProviderType;
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  enabled?: boolean;
};

function normalizeNullableString(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decryptLlmApiKey(row: UserLlmApiSettings): string | null {
  const payload = decryptPayload<{ apiKey?: unknown }>(row.apiKeyEncrypted);
  return typeof payload?.apiKey === 'string' ? payload.apiKey : null;
}

function toSafeLlmApiSetting(row: UserLlmApiSettings): UserLlmApiSettingSafe {
  const {
    apiKeyEncrypted: _apiKeyEncrypted,
    encryptionKeyId: _keyId,
    ...rest
  } = row;
  return {
    ...rest,
    hasApiKey: Boolean(_apiKeyEncrypted),
  };
}

export async function getUserLlmApiSettings(
  userId: string,
): Promise<UserLlmApiSettingSafe[]> {
  try {
    const rows = await db
      .select()
      .from(userLlmApiSettings)
      .where(eq(userLlmApiSettings.userId, userId))
      .orderBy(asc(userLlmApiSettings.providerType));

    return rows.map((row: UserLlmApiSettings) => toSafeLlmApiSetting(row));
  } catch (error) {
    console.error('Failed to get user LLM API settings:', error);
    throw new AppError(
      'bad_request:database',
      `Failed to retrieve LLM API settings. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function getUserLlmApiSettingWithApiKey({
  userId,
  providerType,
}: {
  userId: string;
  providerType: LlmApiProviderType;
}): Promise<UserLlmApiSettingWithApiKey | null> {
  try {
    const [row] = await db
      .select()
      .from(userLlmApiSettings)
      .where(
        and(
          eq(userLlmApiSettings.userId, userId),
          eq(userLlmApiSettings.providerType, providerType),
        ),
      )
      .limit(1);

    if (!row) return null;

    return {
      ...toSafeLlmApiSetting(row),
      apiKey: decryptLlmApiKey(row),
    };
  } catch (error) {
    console.error('Failed to get user LLM API setting:', error);
    throw new AppError(
      'bad_request:database',
      `Failed to retrieve LLM API setting. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function upsertUserLlmApiSetting(
  input: UpsertUserLlmApiSettingInput,
): Promise<UserLlmApiSettingSafe> {
  try {
    const now = new Date();
    const apiKey = normalizeNullableString(input.apiKey);
    let baseUrl = normalizeNullableString(input.baseUrl);
    const model = normalizeNullableString(input.model);
    const apiKeyEncrypted =
      apiKey === undefined
        ? undefined
        : apiKey
          ? encryptPayload({ apiKey })
          : null;

    const [existing] = await db
      .select()
      .from(userLlmApiSettings)
      .where(
        and(
          eq(userLlmApiSettings.userId, input.userId),
          eq(userLlmApiSettings.providerType, input.providerType),
        ),
      )
      .limit(1);

    const normalizedBase = validateModelConnectionUpdate({
      protocol: input.providerType,
      previous: existing ? { apiKey: decryptLlmApiKey(existing), baseUrl: existing.baseUrl, model: existing.model, enabled: existing.enabled } : undefined,
      next: { apiKey, baseUrl, model, enabled: input.enabled },
    });
    if (baseUrl !== undefined) baseUrl = normalizedBase;

    if (existing) {
      // Compare-and-swap protects a retained secret from concurrent connection edits.
      const updatedAt = new Date(Math.max(now.getTime(), new Date(existing.updatedAt).getTime() + 1));
      const updatePayload: Record<string, unknown> = { updatedAt };

      if (apiKeyEncrypted !== undefined) {
        updatePayload.apiKeyEncrypted = apiKeyEncrypted;
      }
      if (baseUrl !== undefined) {
        updatePayload.baseUrl = baseUrl;
      }
      if (model !== undefined) {
        updatePayload.model = model;
      }
      if (typeof input.enabled === 'boolean') {
        updatePayload.enabled = input.enabled;
      }

      const [updated] = await db
        .update(userLlmApiSettings)
        .set(updatePayload)
        .where(and(eq(userLlmApiSettings.id, existing.id), eq(userLlmApiSettings.updatedAt, existing.updatedAt)))
        .returning();

      if (!updated) throw new ModelConfigurationError('model_config_conflict', 'saved_connection');
      return toSafeLlmApiSetting(updated);
    }

    const [created] = await db
      .insert(userLlmApiSettings)
      .values({
        id: generateUUID(),
        userId: input.userId,
        providerType: input.providerType,
        apiKeyEncrypted: apiKeyEncrypted ?? null,
        baseUrl: baseUrl ?? null,
        model: model ?? null,
        enabled: input.enabled ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return toSafeLlmApiSetting(created);
  } catch (error) {
    if (error instanceof ModelConfigurationError) throw error;
    console.error('Failed to upsert user LLM API setting:', error);
    throw new AppError(
      'bad_request:database',
      `Failed to store LLM API setting. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function deleteUserLlmApiSetting({
  userId,
  providerType,
}: {
  userId: string;
  providerType: LlmApiProviderType;
}): Promise<void> {
  try {
    await db
      .delete(userLlmApiSettings)
      .where(
        and(
          eq(userLlmApiSettings.userId, userId),
          eq(userLlmApiSettings.providerType, providerType),
        ),
      );
  } catch (error) {
    console.error('Failed to delete user LLM API setting:', error);
    throw new AppError(
      'bad_request:database',
      `Failed to delete LLM API setting. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
