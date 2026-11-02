'use client';
import { Button, Input } from '@openzhiyu/ui';
import { RemixIcon } from '@/components/remix-icon';
import { Field, Note, selectClass, type MachineData } from './common';
export function MachineSettings({
  data,
  updates,
  onChange,
  error,
  busy,
  onReload,
}: {
  data: MachineData | null;
  updates: Record<string, string | null>;
  onChange: (v: Record<string, string | null>) => void;
  error: string;
  busy: string | null;
  onReload: () => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold">本机共享的模型服务</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          向量索引、音频和视频使用部署配置，由 Web 与后台 Worker
          共同读取。这里的修改独立保存。
        </p>
      </div>
      <Note tone="warning">
        保存后需重启 Web 与后台
        Worker。变更向量模型或维度后，应重建相关索引；旧向量不会自动转换。音频模型沿用代码内置选择，视频使用现有百炼兼容链路。
      </Note>
      {error && (
        <div role="alert">
          <Note tone="warning">{error}</Note>
          <Button variant="outline" className="mt-3" onClick={onReload}>
            重新读取本机配置
          </Button>
        </div>
      )}
      {!data && !error && (
        <p className="text-sm text-muted-foreground">正在读取本机服务…</p>
      )}
      {data && (
        <>
          {!data.editable && (
            <Note>
              当前为多用户认证模式，本机部署配置只读。请由部署管理员修改。
            </Note>
          )}
          {data.pendingRestart && (
            <Note tone="warning">
              文件与当前 Web 进程存在差异。重启后请核对；Worker
              的实际状态还需结合运行状态检查。
            </Note>
          )}
          {[
            {
              id: 'embedding',
              name: '向量与记忆检索',
              description: '决定知识库、记忆与文档向量的共同空间。',
              icon: 'database-2',
            },
            {
              id: 'audio',
              name: '语音转写与合成',
              description: '音频服务使用独立地址与密钥。',
              icon: 'mic',
            },
            {
              id: 'video',
              name: '视频生成',
              description: '复用现有的百炼视频任务与轮询链路。',
              icon: 'film',
            },
          ].map((group) => (
            <div key={group.id} className="rounded-xl border p-6">
              <div className="mb-5 flex gap-3">
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                  <RemixIcon name={group.icon} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">{group.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {group.description}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-5">
                {data.fields
                  .filter((f) => f.group === group.id)
                  .map((field) => (
                    <Field
                      key={field.key}
                      id={`machine-${field.key}`}
                      label={field.label}
                      hint={
                        field.overriddenBy
                          ? `由 ${field.overriddenBy} 覆盖，请在该文件修改。`
                          : field.pending
                            ? `文件与当前进程不同 · ${field.secret ? (field.activeHasValue ? '当前进程有密钥' : '当前进程无密钥') : `当前进程：${field.activeValue || '未显式设置'}`}`
                            : field.secret
                              ? field.hasValue
                                ? '文件已有密钥，留空保留。'
                                : '文件未显式设置；同服务的部署密钥别名仍可能生效。'
                              : undefined
                      }
                    >
                      {field.options ? (
                        <select
                          id={`machine-${field.key}`}
                          className={selectClass}
                          value={
                            updates[field.key] ??
                            (field.key in updates ? '' : field.value)
                          }
                          disabled={
                            !data.editable ||
                            Boolean(busy) ||
                            Boolean(field.overriddenBy)
                          }
                          onChange={(e) =>
                            onChange({
                              ...updates,
                              [field.key]: e.target.value || null,
                            })
                          }
                        >
                          <option value="">使用默认值</option>
                          {field.options.map((option) => (
                            <option key={option} value={option}>
                              {option === 'cloud'
                                ? '云端服务'
                                : option === 'local'
                                  ? '本地模型'
                                  : option}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="flex gap-2">
                          <Input
                            id={`machine-${field.key}`}
                            type={field.secret ? 'password' : 'text'}
                            value={
                              updates[field.key] ??
                              (field.key in updates ? '' : field.value)
                            }
                            placeholder={
                              field.secret
                                ? updates[field.key] === null
                                  ? '保存后清除'
                                  : field.hasValue
                                    ? '已保存 · 输入以更换'
                                    : '填写独立服务密钥'
                                : field.placeholder
                            }
                            disabled={
                              !data.editable ||
                              Boolean(busy) ||
                              Boolean(field.overriddenBy)
                            }
                            maxLength={4096}
                            autoComplete={field.secret ? 'new-password' : 'off'}
                            spellCheck={false}
                            onChange={(e) => {
                              const next = { ...updates };
                              if (field.secret && !e.target.value)
                                delete next[field.key];
                              else next[field.key] = e.target.value || null;
                              onChange(next);
                            }}
                          />
                          {field.secret && field.hasValue && (
                            <Button
                              variant="outline"
                              disabled={
                                !data.editable ||
                                Boolean(busy) ||
                                Boolean(field.overriddenBy)
                              }
                              onClick={() => {
                                const next = { ...updates };
                                if (next[field.key] === null)
                                  delete next[field.key];
                                else next[field.key] = null;
                                onChange(next);
                              }}
                            >
                              {updates[field.key] === null ? '撤销' : '清除'}
                            </Button>
                          )}
                        </div>
                      )}
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer">配置字段</summary>
                        <code className="mt-1 block break-all text-[11px]">
                          {field.key}
                        </code>
                      </details>
                    </Field>
                  ))}
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between gap-5 rounded-lg border bg-muted/15 px-5 py-4">
            <p className="text-xs leading-5 text-muted-foreground">
              只修改本页允许的字段，保留其他配置，并备份原文件。
              <br />
              本机密钥保存在本机环境文件中，不会返回浏览器。
            </p>
          </div>
        </>
      )}
    </div>
  );
}
