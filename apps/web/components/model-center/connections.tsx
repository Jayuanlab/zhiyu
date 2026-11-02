'use client';
import { Button, Input, Label, Switch } from '@openzhiyu/ui';
import { RemixIcon } from '@/components/remix-icon';
import { cn } from '@/lib/utils';
import type { ModelProtocol } from '@openzhiyu/shared/model-configuration';
import type {
  ModelCenterDocument,
  ModelCenterConnection,
} from '@openzhiyu/shared/model-center';
import {
  Field,
  Note,
  formatDate,
  protocolLabels,
  selectClass,
  type CenterData,
  type TestResult,
} from './common';
export function Connections({
  document,
  onChange,
  data,
  selected,
  onSelect,
  keys,
  onKeys,
  add,
  remove,
  test,
  testResult,
  busy,
}: {
  document: ModelCenterDocument;
  onChange: (d: ModelCenterDocument) => void;
  data: CenterData;
  selected: string | null;
  onSelect: (id: string) => void;
  keys: Record<string, string | null>;
  onKeys: (keys: Record<string, string | null>) => void;
  add: (protocol: ModelProtocol) => void;
  remove: () => void;
  test: () => void;
  testResult?: TestResult;
  busy: string | null;
}) {
  const current = document.connections.find((c) => c.id === selected),
    saved = data.connections.find((c) => c.id === selected);
  const patch = (update: Partial<ModelCenterConnection>) =>
    current &&
    onChange({
      ...document,
      connections: document.connections.map((c) =>
        c.id === current.id ? { ...c, ...update } : c,
      ),
    });
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">连接你的模型服务</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            每个连接独立保存地址、密钥和默认模型，同一协议可配置多个服务。
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={Boolean(busy) || document.connections.length >= 40}
            onClick={() => add('openai_compatible')}
          >
            <RemixIcon name="add" size="size-4" />
            添加服务
          </Button>
        </div>
      </div>
      {!document.connections.length ? (
        <div className="flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed bg-muted/10 p-10 text-center">
          <div className="mb-4 flex size-14 items-center justify-center rounded-2xl border bg-background">
            <RemixIcon
              name="plug"
              className="text-muted-foreground"
              size="size-6"
            />
          </div>
          <h3 className="font-medium">从一个服务连接开始</h3>
          <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
            Pi 支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic
            Messages。 添加一个服务后，即可用于对话、车间、Loop 和辅助用途。
          </p>
          <div className="mt-6 flex gap-3">
            <Button onClick={() => add('openai_compatible')}>
              添加模型服务
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-xl border xl:grid-cols-[250px_minmax(0,1fr)]">
          <aside
            className="space-y-1 border-r bg-muted/15 p-3"
            aria-label="服务连接列表"
          >
            {document.connections.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={selected === item.id}
                onClick={() => onSelect(item.id)}
                className={cn(
                  'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected === item.id
                    ? 'border-border bg-background shadow-sm'
                    : 'border-transparent hover:bg-muted/60',
                )}
              >
                <RemixIcon
                  name={
                    item.protocol === 'anthropic_compatible'
                      ? 'robot-2'
                      : 'chat-3'
                  }
                  size="size-4"
                  className="mt-1 text-muted-foreground"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {item.name || '未命名连接'}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {protocolLabels[item.protocol]}
                  </p>
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        item.enabled
                          ? 'bg-emerald-500'
                          : 'bg-muted-foreground/40',
                      )}
                    />
                    {item.enabled ? '启用' : '停用'}
                    {(document.defaultConnectionId === item.id ||
                      document.defaults[item.protocol] === item.id) && (
                      <span className="ml-2 text-primary">默认</span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </aside>
          {current && (
            <div className="min-w-0 p-6">
              <div className="mb-6 flex items-center justify-between gap-4">
                <div>
                  <h3 className="font-semibold">连接详情</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    密钥加密保存，读取时只显示保存状态。
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Label
                    htmlFor="connection-enabled"
                    className="text-xs text-muted-foreground"
                  >
                    {current.enabled ? '已启用' : '已停用'}
                  </Label>
                  <Switch
                    id="connection-enabled"
                    checked={current.enabled}
                    disabled={Boolean(busy)}
                    onCheckedChange={(enabled) => patch({ enabled })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-5">
                <Field label="连接名称" id="connection-name">
                  <Input
                    id="connection-name"
                    value={current.name}
                    maxLength={100}
                    disabled={Boolean(busy)}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="例如：主力文本服务"
                  />
                </Field>
                <Field label="接口协议" id="connection-protocol">
                  <select
                    id="connection-protocol"
                    className={selectClass}
                    value={current.protocol}
                    disabled={Boolean(busy)}
                    onChange={(e) =>
                      patch({ protocol: e.target.value as ModelProtocol })
                    }
                  >
                    {Object.entries(protocolLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="col-span-2">
                  <Field
                    label="服务地址 · Base URL"
                    id="connection-url"
                    hint="填写服务根地址或 API 前缀，系统统一处理版本路径。更换地址或协议时，需重新填写密钥。"
                  >
                    <Input
                      id="connection-url"
                      value={current.baseUrl}
                      maxLength={2048}
                      disabled={Boolean(busy)}
                      onChange={(e) => patch({ baseUrl: e.target.value })}
                      placeholder={
                        current.protocol === 'openai_compatible'
                          ? 'https://服务地址/v1'
                          : 'https://服务地址'
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                </div>
                <div className="col-span-2">
                  <Field
                    label="默认模型 ID"
                    id="connection-model"
                    hint="填写服务商提供的准确 ID。同一连接可在用途分配中指定其他模型。"
                  >
                    <Input
                      id="connection-model"
                      value={current.model}
                      maxLength={256}
                      disabled={Boolean(busy)}
                      onChange={(e) => patch({ model: e.target.value })}
                      placeholder="填写模型 ID"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                </div>
                <div className="col-span-2">
                  <Field
                    label="API Key"
                    id="connection-key"
                    hint={
                      keys[current.id] === null
                        ? '保存后将清除密钥；启用连接必须有密钥。'
                        : saved?.hasApiKey
                          ? '已有密钥。留空保留，输入新值则替换。'
                          : '尚未保存密钥。密钥仅用于当前连接，不与其他服务混用。'
                    }
                  >
                    <div className="flex gap-2">
                      <Input
                        id="connection-key"
                        type="password"
                        value={keys[current.id] ?? ''}
                        maxLength={4096}
                        disabled={Boolean(busy)}
                        onChange={(e) => {
                          const next = { ...keys };
                          if (e.target.value) next[current.id] = e.target.value;
                          else delete next[current.id];
                          onKeys(next);
                        }}
                        placeholder={
                          saved?.hasApiKey
                            ? '已保存 · 输入以更换'
                            : '填写 API Key'
                        }
                        autoComplete="new-password"
                        spellCheck={false}
                      />
                      {saved?.hasApiKey && (
                        <Button
                          variant="outline"
                          disabled={Boolean(busy)}
                          onClick={() => {
                            const next = { ...keys };
                            if (next[current.id] === null)
                              delete next[current.id];
                            else next[current.id] = null;
                            onKeys(next);
                          }}
                        >
                          {keys[current.id] === null ? '撤销清除' : '清除密钥'}
                        </Button>
                      )}
                    </div>
                  </Field>
                </div>
              </div>
              <div className="mt-6 flex items-center justify-between border-t pt-5">
                <Button
                  variant="outline"
                  disabled={
                    Boolean(busy) ||
                    !current.enabled ||
                    keys[current.id] === null ||
                    !current.baseUrl ||
                    !current.model ||
                    !(keys[current.id] || saved?.hasApiKey)
                  }
                  onClick={test}
                >
                  <RemixIcon
                    name={busy === 'test' ? 'loader-4' : 'pulse'}
                    size="size-4"
                    className={busy === 'test' ? 'animate-spin' : ''}
                  />
                  {busy === 'test' ? '测试中…' : '测试文本连接'}
                </Button>
                <Button
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={Boolean(busy)}
                  onClick={remove}
                >
                  <RemixIcon name="delete-bin" size="size-4" />
                  移除连接
                </Button>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                测试会发送一条简短请求，可能产生少量费用。不会执行工具或生成图片、视频。
              </p>
              {testResult && (
                <div className="mt-4" role="status">
                  <Note tone={testResult.passed ? 'success' : 'warning'}>
                    <div className="flex items-center justify-between gap-3">
                      <strong className="font-medium">
                        {testResult.passed ? '文本测试通过' : '文本测试失败'}
                        {testResult.persisted === false
                          ? ' · 未保存草稿'
                          : ` · v${testResult.revision}`}
                      </strong>
                      <span className="text-xs">
                        {testResult.durationMs} ms
                      </span>
                    </div>
                    <p>{testResult.detail}</p>
                    <p className="mt-1 break-all text-xs opacity-80">
                      {testResult.model} ·{' '}
                      {formatDate(testResult.testedAt ?? testResult.createdAt)}
                    </p>
                  </Note>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="rounded-xl border p-5 space-y-5">
        <div>
          <h3 className="text-sm font-semibold">默认模型服务</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            对话、Pi
            执行和辅助用途共用此连接。用途或档位可以单独分配；协议、地址和密钥始终一起选择。
          </p>
        </div>
        <Field label="默认服务连接" id="default-model-connection">
          <select
            id="default-model-connection"
            className={selectClass}
            value={document.defaultConnectionId ?? ''}
            disabled={Boolean(busy)}
            onChange={(e) =>
              onChange({
                ...document,
                defaultConnectionId: e.target.value || null,
              })
            }
          >
            <option value="">继承部署 / 协议默认配置</option>
            {document.connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {protocolLabels[c.protocol]}
                {c.enabled ? '' : '（已停用，将阻止调用）'}
              </option>
            ))}
          </select>
        </Field>
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            高级：按协议设置兼容默认项
          </summary>
          <p className="my-3 text-xs leading-5 text-muted-foreground">
            未选择默认服务连接时使用。图像生成仍需服务本身支持图像接口，文本测试不验证图像能力。
          </p>
          <div className="grid grid-cols-3 gap-4">
            {(
              [
                'openai_compatible',
                'openai_responses',
                'anthropic_compatible',
              ] as const
            ).map((protocol) => (
              <Field
                key={protocol}
                label={protocolLabels[protocol]}
                id={`default-${protocol}`}
              >
                <select
                  id={`default-${protocol}`}
                  className={selectClass}
                  value={document.defaults[protocol] ?? ''}
                  disabled={Boolean(busy)}
                  onChange={(e) =>
                    onChange({
                      ...document,
                      defaults: {
                        ...document.defaults,
                        [protocol]: e.target.value || null,
                      },
                    })
                  }
                >
                  <option value="">继承部署配置</option>
                  {document.connections
                    .filter((c) => c.protocol === protocol)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.enabled ? '' : '（已停用）'}
                      </option>
                    ))}
                </select>
              </Field>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}
