import type { PiModelProtocol } from './pi-model-config';

/** Official Go model protocol, verified against the provider endpoint table.
 * Only this observed model and the provider's exact Go base paths migrate.
 * Custom proxies, other models and non-HTTPS URLs retain their contracts.
 * https://opencode.ai/v2/docs/console/go/#endpoints */
export function resolveOpenCodeGoModelEndpoint(input: {
  baseUrl?: string;
  model: string;
  protocol?: PiModelProtocol;
}): { baseUrl?: string; protocol?: PiModelProtocol; migrated: boolean } {
  const unchanged = { baseUrl: input.baseUrl, protocol: input.protocol, migrated: false };
  if (input.model.trim().toLowerCase() !== 'qwen3.7-plus' || !input.baseUrl) return unchanged;
  let url: URL;
  try { url = new URL(input.baseUrl); } catch { return unchanged; }
  if (url.origin !== 'https://opencode.ai' || url.username || url.password || url.search || url.hash) return unchanged;
  const path = url.pathname.replace(/\/+$/, '');
  if (!['/zen/go', '/zen/go/v1', '/inference/go/anthropic', '/inference/go/anthropic/v1'].includes(path)) return unchanged;
  const baseUrl = 'https://opencode.ai/inference/go/anthropic';
  return { baseUrl, protocol: 'anthropic-messages',
    migrated: input.baseUrl.replace(/\/+$/, '') !== baseUrl || input.protocol !== 'anthropic-messages' };
}

export function isOfficialOpenCodeGoBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://opencode.ai' && !url.username && !url.password && !url.search && !url.hash
      && /^\/(?:zen\/go|inference\/go\/(?:anthropic|openai))(?:\/v1)?\/?$/.test(url.pathname);
  } catch { return false; }
}
