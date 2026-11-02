import {
  resolveModelConfiguration,
  type ModelConfiguration,
} from '@openzhiyu/shared/model-configuration';
import {
  resolveCenterModelConfiguration,
  type ModelCenterSnapshot,
} from '@openzhiyu/shared/model-center';
import { customProvider, type LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {createPiLanguageModel} from '../runtime/pi-language-model';
import {modelProtocolToPi} from '@openzhiyu/shared/model-configuration';
import { DEV_PORT, PROD_PORT } from '@openzhiyu/shared';
import { AsyncLocalStorage } from 'node:async_hooks';

export type UserType =
  | 'guest'
  | 'regular'
  | 'slack'
  | 'discord'
  | 'google'
  | 'basic'
  | 'pro'
  | 'team'
  | 'enterprise'
  | 'free';
export interface AIUserContext {
  id: string;
  email: string | null | undefined;
  name: string | null | undefined;
  type: string;
  token?: string;
  modelCenterSnapshot?: ModelCenterSnapshot;
  llmApiSettings?: {
    openaiCompatible?: { apiKey: string; baseUrl: string; model: string };
  };
}
const userContextStorage = new AsyncLocalStorage<AIUserContext | null>();
export function setAIUserContext(context: AIUserContext | null) {
  userContextStorage.enterWith(context);
}
export function clearAIUserContext() {
  userContextStorage.enterWith(null);
}
export function getAIUserContext() {
  return userContextStorage.getStore() ?? null;
}

type Purpose = 'text' | 'vision' | 'image';
function configuration(
  purpose: Purpose,
  isNativeMode: boolean,
  context: AIUserContext | null,
  modelOverride?: string,
) {
  const env = { ...process.env };
  if (context?.modelCenterSnapshot) {
    const config = resolveCenterModelConfiguration(
      context.modelCenterSnapshot,
      { purpose, env, modelOverride },
    );
    if (!config) throw new Error(`model_not_configured: ${purpose}`);
    return config;
  }
  const users = {
    openai_compatible: context?.llmApiSettings?.openaiCompatible,
  };
  if (isNativeMode && !users.openai_compatible) {
    env.LLM_BASE_URL = `${process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${process.env.NODE_ENV === 'production' ? PROD_PORT : DEV_PORT}`}/api/ai/v1`;
    env.LLM_API_KEY = 'local-auth-via-jwt-token';
  }
  const config = resolveModelConfiguration({
    purpose,
    users,
    env,
    modelOverride,
  });
  if (!config) throw new Error(`model_not_configured: ${purpose}`);
  return config;
}
/** App JWTs are only for the application's own proxy, never an external model host. */
function transport(
  config: ModelConfiguration,
  context: AIUserContext | null,
): typeof fetch {
  let proxy = false;
  try {
    const base = new URL(config.baseUrl),
      app = new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3515');
    proxy =
      base.origin === app.origin && base.pathname.startsWith('/api/ai/v1');
  } catch {}
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    if (proxy) {
      if (!context?.token) throw new Error('local_proxy_auth_token_required');
      headers.set('Authorization', `Bearer ${context.token}`);
    }
    return fetch(url, { ...init, headers, keepalive: true, redirect: 'error' });
  };
}
function languageModel(
  purpose: 'text' | 'vision',
  isNativeMode: boolean,
  context: AIUserContext | null,
  modelOverride?: string,
) {
  const config = configuration(purpose, isNativeMode, context, modelOverride);
  return createPiLanguageModel({apiKey:config.apiKey,baseUrl:config.baseUrl,model:config.model,protocol:modelProtocolToPi(config.protocol)},transport(config,context));
}
export function getModel(isNativeMode: boolean): LanguageModel {
  return languageModel('text', isNativeMode, getAIUserContext());
}
export function getVLMModel(isNativeMode: boolean): LanguageModel {
  return languageModel('vision', isNativeMode, getAIUserContext());
}
export function createDynamicModel(
  isNativeMode: boolean,
  modelName?: string,
): LanguageModel {
  return languageModel('text', isNativeMode, getAIUserContext(), modelName);
}
/** Lazy purpose getters keep a disabled image/vision binding from blocking text. */
export function getModelProvider(
  isNativeMode: boolean,
): ReturnType<typeof customProvider> {
  const context = getAIUserContext();
  return customProvider({
    languageModels: {
      get 'chat-model'() {
        return languageModel('text', isNativeMode, context);
      },
      get 'title-model'() {
        return languageModel('text', isNativeMode, context);
      },
      get 'artifact-model'() {
        return languageModel('text', isNativeMode, context);
      },
      get 'vlm-model'() {
        return languageModel('vision', isNativeMode, context);
      },
    },
    imageModels: {
      get 'small-model'() {
        const config = configuration('image', isNativeMode, context);
        return createOpenAICompatible({
          name: 'image',
          baseURL: config.baseUrl,
          apiKey: config.apiKey,
          fetch: transport(config, context),
        }).imageModel(config.model);
      },
    },
  });
}
