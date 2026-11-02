import {
  getUserLlmApiSettingWithApiKey,
  type LlmApiProviderType,
} from "@/lib/db/llm-api-settings-queries";
import { ModelConfigurationError, normalizeModelBaseUrl } from "@openzhiyu/shared/model-configuration";

export type UserLlmProviderConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  revision?: string;
};

export async function getUserLlmProviderConfig({
  userId,
  providerType,
}: {
  userId: string;
  providerType: LlmApiProviderType;
}): Promise<UserLlmProviderConfig | undefined> {
    // Legacy-only bridge. Callers capture the center head first and use this
    // reader only when no head existed at operation start. Do not re-read the
    // head between protocol lookups, which could mix two concurrent versions.
    const setting = await getUserLlmApiSettingWithApiKey({
      userId,
      providerType,
    });

    // Missing/disabled override inherits system defaults. A broken enabled
    // override or failed database/decryption must never switch providers silently.
    if (!setting?.enabled) return undefined;
    if (!setting.apiKey?.trim() || !setting.baseUrl?.trim() || !setting.model?.trim())
      throw new ModelConfigurationError("model_config_incomplete", `user:${providerType}`);

    return {
      apiKey: setting.apiKey.trim(),
      baseUrl: normalizeModelBaseUrl(setting.baseUrl, `user:${providerType}`),
      model: setting.model.trim(),
      revision: new Date(setting.updatedAt).toISOString(),
    };
}
