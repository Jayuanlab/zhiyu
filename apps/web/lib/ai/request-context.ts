/**
 * AI Request Context Helper
 *
 * Used to set AI Provider user context in API routes
 * Supports extracting cloud authentication token from request body or Authorization header.
 *
 * Re-exports core context functions from @openzhiyu/ai and adds app-specific helpers.
 */

import type { UserType } from '@/app/(auth)/auth';
import { NextRequest } from 'next/server';
import { setAIUserContext } from '@openzhiyu/ai/agent/model';
import { getUserLlmProviderConfig } from '@/lib/ai/user-llm-api-settings';
import { readModelCenterSnapshot } from '@/lib/ai/model-center-store';

export {
  setAIUserContext,
  clearAIUserContext,
  getAIUserContext,
} from '@openzhiyu/ai/agent/model';
export type { AIUserContext } from '@openzhiyu/ai/agent/model';

/**
 * Extract cloud authentication token from request
 * Priority: body.cloudAuthToken > Authorization Bearer header
 */
export function extractCloudAuthToken(
  request: NextRequest | Request,
  body?: any,
): string | undefined {
  if (body?.cloudAuthToken) {
    return body.cloudAuthToken;
  }

  let authHeader: string | null;
  if (request instanceof NextRequest) {
    authHeader = request.headers.get('authorization');
  } else {
    authHeader = request.headers.get('Authorization');
  }

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (token) {
      return token;
    }
  }

  return undefined;
}

/**
 * Set AI user context (extract token from request)
 */
export async function setAIUserContextFromRequest({
  userId,
  email,
  name,
  userType,
  request,
  body,
}: {
  userId: string;
  email: string;
  name: string | null;
  userType: UserType;
  request: NextRequest | Request;
  body?: any;
}): Promise<void> {
  const token = extractCloudAuthToken(request, body);
  const modelCenterSnapshot = await readModelCenterSnapshot(userId);
  const openaiCompatible = modelCenterSnapshot
    ? undefined
    : await getUserLlmProviderConfig({
        userId,
        providerType: 'openai_compatible',
      });

  setAIUserContext({
    id: userId,
    email: email || '',
    name: name || null,
    type: userType,
    token,
    modelCenterSnapshot: modelCenterSnapshot ?? undefined,
    llmApiSettings: openaiCompatible
      ? {
          openaiCompatible,
        }
      : undefined,
  });
}
