export const AI_SETTINGS_CHANGED_EVENT = "openzhiyu:ai-settings-changed";
export const MISSING_API_KEY_REASON = "missing-api-key";

type ConversationProviderSetting = {
  providerType: string;
  baseUrl: string | null;
  model: string | null;
  enabled: boolean;
  hasApiKey: boolean;
};

type ConversationSystemDefault = {
  hasApiKey: boolean;
};

export type ConversationApiSettingsResponse = {
  effective?: { conversation?: { configured: boolean } };
  settings: ConversationProviderSetting[];
  systemDefaults: {
    openai_compatible: ConversationSystemDefault;
    anthropic_compatible: ConversationSystemDefault;
  };
};

function hasText(value: string | null) {
  return Boolean(value?.trim());
}

export function hasUsableConversationApiConfiguration(
  response: ConversationApiSettingsResponse,
) {
  if (response.effective?.conversation) return response.effective.conversation.configured;
  const hasUserConfiguration = response.settings.some(
    (setting) =>
      (setting.providerType === "openai_compatible" ||
        setting.providerType === "anthropic_compatible") &&
      setting.enabled &&
      setting.hasApiKey &&
      hasText(setting.baseUrl) &&
      hasText(setting.model),
  );

  return (
    hasUserConfiguration ||
    response.systemDefaults.openai_compatible.hasApiKey ||
    response.systemDefaults.anthropic_compatible.hasApiKey
  );
}
