'use client';
import type { ReactNode } from 'react';
import { Label } from '@openzhiyu/ui';
import { cn, fetchWithAuth } from '@/lib/utils';
import type {
  ModelProtocol,
  ModelPurpose,
} from '@openzhiyu/shared/model-configuration';
import type { SafeModelCenterSnapshot } from '@openzhiyu/shared/model-center';
export type Effective = {
  configured: boolean;
  model?: string;
  source?: string;
  revision?: string;
  error?: string;
  connectionName?: string;
};
export type TestResult = {
  connectionId: string;
  revision: number;
  model: string;
  passed: boolean;
  detail: string;
  durationMs: number;
  createdAt?: string;
  testedAt?: string;
  persisted?: boolean;
};
export type CenterData = SafeModelCenterSnapshot & {
  effective: Record<string, Effective> & {
    agent_tiers: Record<string, Effective>;
  };
  history: Array<{
    revision: number;
    action: string;
    restoredFrom: number | null;
    createdAt: string;
    connectionCount: number;
  }>;
  tests: TestResult[];
  observedAt: string;
};
export type MachineField = {
  legacy?: boolean;
  sourceHint?: string;
  key: string;
  label: string;
  group: string;
  secret?: boolean;
  options?: string[];
  placeholder?: string;
  value: string;
  hasValue: boolean;
  activeHasValue: boolean;
  activeValue?: string;
  pending: boolean;
  overriddenBy?: string;
};
export type MachineData = {
  revision: string;
  editable: boolean;
  pendingRestart: boolean;
  fields: MachineField[];
  observedAt: string;
};
export type Confirmation = {
  title: string;
  description: string;
  label: string;
  action: () => void;
};
export const protocolLabels: Record<ModelProtocol, string> = {
  openai_compatible: 'OpenAI Chat Completions',
  openai_responses: 'OpenAI Responses',
  anthropic_compatible: 'Anthropic Messages',
};
export const tierLabels: Record<string, { name: string; description: string }> =
  {
    cheap: { name: '轻量', description: '低成本、简单执行' },
    standard: { name: '标准', description: '日常车间与任务执行' },
    review: { name: '复核', description: '结果复核与交叉检查' },
    audit: { name: '审计', description: '复杂分析与深入审查' },
    vision: { name: '视觉', description: '智能体图像输入' },
  };
export const purposeDescriptions: Record<ModelPurpose, string> = {
  text: '文本对话与通用生成',
  agent: 'Pi 对话、车间和 Loop 执行',
  conversation_compaction: '整理长对话，控制上下文长度',
  workshop_planner: '将目标拆解为车间工作计划',
  loop_parser: '将自然语言转为持续任务',
  interaction_processor: '理解交互并整理长期记忆',
  recall_planner: '规划记忆检索与召回',
  report_evaluator: '检查报告质量与完整性',
  loop_checker: '检查持续任务的执行结果',
  vision: '图像输入的理解模型，需服务支持',
  image: '图像模型槽位，完整工作流尚需验证',
};
const errors: Record<string, string> = {
  configuration_conflict:
    '配置已被其他页面修改。请先复制需要保留的内容，再重新载入。',
  connection_incomplete: '启用连接前，请填写服务地址、模型 ID 和密钥。',
  host_change_requires_key:
    '地址或协议已改变，请重新填写对应密钥，避免旧密钥发往新服务。',
  model_config_host_change_requires_key: '服务地址已改变，请重新填写对应密钥。',
  model_config_invalid_url:
    '地址无效，请填写不含账号、查询参数和片段的 HTTP(S) 地址。',
  assignment_protocol_mismatch: '用途与连接协议不兼容。',
  assignment_connection_missing: '分配引用的连接不存在，请重新选择。',
  default_protocol_mismatch: '默认连接与协议不匹配。',
  model_connection_disabled: '引用的连接已停用',
  model_purpose_disabled: '该用途已停用',
  model_config_incomplete: '缺少完整配置',
  model_center_unavailable:
    '暂时无法读取或保存配置，请检查数据库和服务日志后重试。',
  machine_settings_owner_only: '仅本机所有者可以修改部署配置。',
  machine_field_overridden: '字段由其他环境文件覆盖，请先处理覆盖来源。',
  machine_configuration_busy: '另一个保存正在进行，请稍后重试。',
  machine_test_key_required: '请填写这项服务的独立密钥，再开始测试。',
  machine_test_busy: '另一项同类测试正在准备，请稍后查询已有记录。',
  machine_test_already_running: '相同配置已有未完成的测试，请查询已有任务。',
  machine_test_request_conflict: '测试请求标识已用于其他输入，请重新发起测试。',
  machine_test_not_found: '没有找到属于当前用户的测试记录。',
  runtime_test_has_draft: '运行配置测试不接受草稿字段。',
  invalid_machine_value: '字段格式无效，请检查维度、选项或特殊字符。',
  invalid_configuration: '配置格式不正确，请检查填写内容。',
  configuration_decryption_failed: '无法解密，请检查本机加密配置。',
  duplicate_connection: '连接标识重复，请重新创建。',
};
export const selectClass =
  'h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
export const formatDate = (value?: string) =>
  value
    ? new Date(value).toLocaleString('zh-CN', { hour12: false })
    : '尚无记录';
export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? (errors[error.message] ?? error.message)
    : '操作失败，请重试。';
export const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
export async function modelRequest<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetchWithAuth(url, { cache: 'no-store', ...options });
  const data = await response
    .json()
    .catch(() => ({ error: '服务返回了无效响应' }));
  if (!response.ok) throw Error(data.error ?? '请求失败');
  return data;
}
export function Note({
  children,
  tone = 'muted',
}: { children: ReactNode; tone?: 'muted' | 'warning' | 'success' }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-4 py-3 text-sm leading-6',
        tone === 'warning'
          ? 'border-amber-500/25 bg-amber-500/5 text-amber-800 dark:text-amber-300'
          : tone === 'success'
            ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300'
            : 'border-border bg-muted/25 text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}
export function Field({
  label,
  id,
  hint,
  children,
}: { label: string; id?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      {children}
      {hint && (
        <p className="text-xs leading-5 text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
export function ConfigurationState({ config }: { config?: Effective }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs',
        config?.configured
          ? 'text-emerald-700 dark:text-emerald-400'
          : config?.error
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          config?.configured
            ? 'bg-emerald-500'
            : config?.error
              ? 'bg-amber-500'
              : 'bg-muted-foreground/40',
        )}
      />
      {config?.configured
        ? '已解析'
        : config?.error
          ? (errors[config.error] ?? '配置异常')
          : '待配置'}
    </span>
  );
}
export function sourceLabel(config?: Effective) {
  if (!config?.configured) return '无可用配置';
  if (config.connectionName) return config.connectionName;
  if (config.source?.startsWith('env:'))
    return `部署配置 · ${config.source.slice(4)}`;
  return config.source?.startsWith('user:')
    ? '默认连接'
    : (config.source ?? '部署默认');
}
