import {
  completeConfiguredText,
  normalizePiModelConfiguration,
} from './model-configuration';
import {
  modelProtocolToPi,
  type ModelConfiguration,
} from '@openzhiyu/shared/model-configuration';
/** Exercise the same Pi serializer as real calls, including terminal admission. */
export async function testModelConnection(connection: ModelConfiguration) {
  const config = normalizePiModelConfiguration(connection)!;
  const started = Date.now();
  try {
    await completeConfiguredText(config, {
      prompt: 'Reply with OK.',
      maxTokens: 64,
      signal: AbortSignal.timeout(20000),
    });
    return {
      passed: true,
      detail: `${modelProtocolToPi(config.protocol)} 文本响应有效；工具调用、视觉及任务执行能力尚未验证。`,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      passed: false,
      detail:
        error instanceof Error &&
        ['TimeoutError', 'AbortError'].includes(error.name)
          ? '请求超时（20 秒），请检查服务与网络。'
          : 'Pi 未收到完整有效的文本响应。请检查所选协议、接口地址、模型权限和密钥；不完整或中断的输出不算测试通过。',
      durationMs: Date.now() - started,
    };
  }
}
