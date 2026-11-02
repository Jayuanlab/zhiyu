'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@openzhiyu/ui';
import { RemixIcon } from '@/components/remix-icon';
import { cn } from '@/lib/utils';
import { AI_SETTINGS_CHANGED_EVENT } from '@/lib/ai/conversation-api-configuration';
import {
  MODEL_PURPOSES,
  type ModelProtocol,
} from '@openzhiyu/shared/model-configuration';
import type {
  ModelCenterDocument,
  SafeModelCenterSnapshot,
} from '@openzhiyu/shared/model-center';
import { Connections } from './model-center/connections';
import { Assignments } from './model-center/assignments';
import { MachineSettings } from './model-center/machine';
import {
  Note,
  modelRequest,
  json,
  errorMessage,
  formatDate,
  protocolLabels,
  type CenterData,
  type MachineData,
  type Confirmation,
  type TestResult,
} from './model-center/common';
type Tab = 'connections' | 'assignments' | 'machine' | 'history';
const tabs: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'connections', label: '服务连接', icon: 'links' },
  { id: 'assignments', label: '用途与档位', icon: 'route' },
  { id: 'machine', label: '本机服务', icon: 'server' },
  { id: 'history', label: '变更记录', icon: 'history' },
];

export function AiApiSettings() {
  const scrollArea = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<CenterData | null>(null),
    [draft, setDraft] = useState<ModelCenterDocument | null>(null),
    [keys, setKeys] = useState<Record<string, string | null>>({});
  const [tab, setTab] = useState<Tab>('connections'),
    [selected, setSelected] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [machine, setMachine] = useState<MachineData | null>(null),
    [machineError, setMachineError] = useState(''),
    [machineUpdates, setMachineUpdates] = useState<
      Record<string, string | null>
    >({});
  const [test, setTest] = useState<
    (TestResult & { fingerprint: string }) | null
  >(null);
  const dirty = Boolean(
      data &&
        draft &&
        (JSON.stringify(data.document) !== JSON.stringify(draft) ||
          Object.keys(keys).length),
    ),
    hasChanges = dirty || Object.keys(machineUpdates).length > 0;
  const accept = useCallback((next: CenterData) => {
    setData(next);
    setDraft(structuredClone(next.document));
    setKeys({});
    setTest(null);
    setSelected((old) =>
      next.connections.some((c) => c.id === old)
        ? old
        : (next.connections[0]?.id ?? null),
    );
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      accept(await modelRequest<CenterData>('/api/preferences/models'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [accept]);
  const loadMachine = useCallback(async () => {
    setMachineError('');
    try {
      setMachine(
        await modelRequest<MachineData>('/api/preferences/models/machine'),
      );
      setMachineUpdates({});
    } catch (e) {
      setMachineError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
    void loadMachine();
  }, [load, loadMachine]);
  useEffect(() => {
    if (!hasChanges) return;
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    const navigation = (e: MouseEvent) => {
      const link = (e.target as Element).closest?.(
        'a[href], [data-navigation-href]',
      );
      if (
        !link ||
        link.getAttribute('target') === '_blank' ||
        e.ctrlKey ||
        e.metaKey ||
        e.defaultPrevented
      )
        return;
      const href =
        link.getAttribute('href') ?? link.getAttribute('data-navigation-href');
      if (
        !href ||
        href.startsWith('#') ||
        new URL(href, location.href).href === location.href
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      setConfirmation({
        title: '离开配置页面？',
        description: '尚有未保存的更改，离开后将丢失。',
        label: '放弃更改并离开',
        action: () => {
          window.removeEventListener('beforeunload', unload);
          window.location.assign(href);
        },
      });
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', navigation, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', navigation, true);
    };
  }, [hasChanges]);
  const current = draft?.connections.find((c) => c.id === selected),
    fingerprint = JSON.stringify([
      current,
      selected ? keys[selected] : undefined,
    ]);
  const currentTest =
    test?.connectionId === selected && test.fingerprint === fingerprint
      ? test
      : !dirty
        ? data?.tests.find(
            (t) =>
              t.connectionId === selected &&
              t.revision === data.revision &&
              t.model === current?.model,
          )
        : undefined;
  const save = async () => {
    if (!data || !draft) return;
    const incomplete = draft.connections.find(
      (c) =>
        !c.name.trim() ||
        (c.enabled &&
          (!c.baseUrl.trim() ||
            !c.model.trim() ||
            keys[c.id] === null ||
            !(
              keys[c.id]?.trim() ||
              data.connections.find((s) => s.id === c.id)?.hasApiKey
            ))),
    );
    if (incomplete) {
      setSelected(incomplete.id);
      setTab('connections');
      setError(
        `请补全“${incomplete.name || '未命名连接'}”的名称、服务地址、模型 ID 和密钥，或暂时停用此连接。`,
      );
      return;
    }
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const result = await modelRequest<CenterData>(
        '/api/preferences/models',
        json(
          {
            expectedRevision: data.revision,
            document: draft,
            secretUpdates: keys,
          },
          'PUT',
        ),
      );
      accept(result);
      window.dispatchEvent(new Event(AI_SETTINGS_CHANGED_EVENT));
      setNotice(
        `配置 v${result.revision} 已保存。新请求与新任务将读取此版本，正在执行的任务保留原快照。`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const add = (protocol: ModelProtocol) => {
    if (!draft) return;
    const id = crypto.randomUUID();
    setDraft({
      ...draft,
      connections: [
        ...draft.connections,
        {
          id,
          name: `模型服务 ${draft.connections.length + 1}`,
          protocol,
          baseUrl: '',
          model: '',
          enabled: false,
        },
      ],
    });
    setSelected(id);
    setTab('connections');
    setNotice('');
  };
  const remove = () => {
    if (!draft || !current) return;
    const bound = Object.entries(draft.assignments)
        .filter(
          ([, a]) => a.mode === 'connection' && a.connectionId === current.id,
        )
        .map(([key]) => key),
      defaults = Object.values(draft.defaults).filter(
        (id) => id === current.id,
      ).length;
    setConfirmation({
      title: `移除“${current.name}”？`,
      description: `先进入草稿，保存后生效。${bound.length || defaults ? `清除 ${bound.length} 处用途/档位分配及 ${defaults} 处默认连接，改为继承部署配置。` : '已保存版本仍可在变更记录中恢复。'}`,
      label: '移除并更新草稿',
      action: () => {
        const connections = draft.connections.filter(
          (c) => c.id !== current.id,
        );
        setDraft({
          ...draft,
          connections,
          defaultConnectionId:
            draft.defaultConnectionId === current.id
              ? null
              : draft.defaultConnectionId,
          defaults: {
            openai_responses:
              draft.defaults.openai_responses === current.id
                ? null
                : draft.defaults.openai_responses,
            openai_compatible:
              draft.defaults.openai_compatible === current.id
                ? null
                : draft.defaults.openai_compatible,
            anthropic_compatible:
              draft.defaults.anthropic_compatible === current.id
                ? null
                : draft.defaults.anthropic_compatible,
          },
          assignments: Object.fromEntries(
            Object.entries(draft.assignments).filter(
              ([key]) => !bound.includes(key),
            ),
          ),
        });
        setKeys((old) =>
          Object.fromEntries(
            Object.entries(old).filter(([id]) => id !== current.id),
          ),
        );
        setSelected(connections[0]?.id ?? null);
      },
    });
  };
  const testConnection = async () => {
    if (!current || !data) return;
    setBusy('test');
    setError('');
    try {
      const isDraft =
        JSON.stringify(current) !==
          JSON.stringify(
            data.document.connections.find((c) => c.id === current.id),
          ) ||
        current.id in keys ||
        data.revision === 0;
      const result = await modelRequest<Omit<TestResult, 'connectionId'>>(
        '/api/preferences/models/test',
        json({
          revision: data.revision,
          connectionId: current.id,
          ...(isDraft
            ? { draft: current, apiKey: keys[current.id] ?? undefined }
            : {}),
        }),
      );
      setTest({ ...result, connectionId: current.id, fingerprint });
      if (result.persisted)
        setData((old) =>
          old
            ? {
                ...old,
                tests: [{ ...result, connectionId: current.id }, ...old.tests],
              }
            : old,
        );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const saveMachine = async () => {
    if (!machine) return;
    setBusy('machine');
    setMachineError('');
    try {
      setMachine(
        await modelRequest<MachineData>(
          '/api/preferences/models/machine',
          json(
            { expectedRevision: machine.revision, updates: machineUpdates },
            'PUT',
          ),
        ),
      );
      setMachineUpdates({});
      setNotice(
        '本机配置已写入，原文件已备份。请重启 Web 与后台 Worker，再核对实际生效值。',
      );
    } catch (e) {
      setMachineError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const rollback = async (revision: number) => {
    if (!data) return;
    setBusy('review');
    setError('');
    let previous: SafeModelCenterSnapshot;
    try {
      previous = await modelRequest<SafeModelCenterSnapshot>(
        `/api/preferences/models/history?revision=${revision}`,
      );
    } catch (error) {
      setError(errorMessage(error));
      return;
    } finally {
      setBusy(null);
    }
    const connections = previous.connections
      .map(
        (c) =>
          `${c.name}：${c.enabled ? '启用' : '停用'} · ${c.model || '未选模型'} · ${c.baseUrl || '无地址'} · ${c.hasApiKey ? '有密钥' : '无密钥'}`,
      )
      .join('\n');
    const assignments = Object.entries(previous.document.assignments)
      .map(
        ([key, value]) =>
          `${key.startsWith('agent:') ? `智能体 ${key.slice(6)}` : (MODEL_PURPOSES[key as keyof typeof MODEL_PURPOSES]?.label ?? key)}：${value.mode === 'connection' ? `${previous.connections.find((c) => c.id === value.connectionId)?.name ?? '缺失连接'} / ${value.model || '连接默认模型'}` : value.mode === 'disabled' ? '停用' : '继承'}`,
      )
      .join('\n');
    const defaults = Object.entries(previous.document.defaults)
      .map(
        ([key, id]) =>
          `${protocolLabels[key as ModelProtocol]} 默认：${previous.connections.find((c) => c.id === id)?.name ?? '继承部署'}`,
      )
      .join('\n');
    setConfirmation({
      title: `恢复到 v${revision} 的配置？`,
      description: `连接、密钥、默认项、用途和档位一起恢复，并生成新版本。正在执行的任务保留原快照；本机服务配置不受影响。\n\n${connections || '无服务连接'}\n\n默认服务：${previous.connections.find((c) => c.id === previous.document.defaultConnectionId)?.name ?? '继承部署 / 协议默认配置'}\n${defaults}\n\n${assignments || '所有用途继承默认解析'}`,
      label: '恢复并生成新版本',
      action: () => {
        void (async () => {
          setBusy('rollback');
          setError('');
          try {
            const result = await modelRequest<CenterData>(
              '/api/preferences/models/rollback',
              json({
                expectedRevision: data.revision,
                restoreRevision: revision,
              }),
            );
            accept(result);
            window.dispatchEvent(new Event(AI_SETTINGS_CHANGED_EVENT));
            setNotice(`已将 v${revision} 恢复为新版本 v${result.revision}。`);
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(null);
          }
        })();
      },
    });
  };
  const discard = () =>
    setConfirmation({
      title: '放弃未保存的更改？',
      description: '连接、分配和本机服务表单将重新载入已保存的配置。',
      label: '放弃并重新载入',
      action: () => {
        void load();
        void loadMachine();
        setNotice('');
      },
    });
  if (loading && !data)
    return (
      <div className="flex h-full items-center justify-center gap-3 text-sm text-muted-foreground">
        <RemixIcon name="loader-4" className="animate-spin" />
        正在读取模型配置…
      </div>
    );
  if (!data || !draft)
    return (
      <div className="mx-auto max-w-2xl space-y-5 p-10">
        <h1 className="text-2xl font-semibold">模型配置中心</h1>
        <Note tone="warning">{error || '无法读取配置'}</Note>
        <Button onClick={() => void load()}>重新载入</Button>
      </div>
    );
  const ready = Object.keys(MODEL_PURPOSES).filter(
    (key) => data.effective[key]?.configured,
  ).length;
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="model-center"
    >
      <div ref={scrollArea} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1240px] px-6 pb-12 pt-8 xl:px-10">
          <header className="mb-7 flex items-start justify-between gap-6">
            <div>
              <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                <RemixIcon name="settings-3" size="size-4" />
                设置<span>/</span>
                <span>模型与服务</span>
              </div>
              <h1 className="text-[28px] font-semibold tracking-tight">
                模型配置中心
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                统一管理 Pi 的模型连接、用途和档位，三种协议使用同一份配置。
              </p>
            </div>
            <div className="mt-9 flex shrink-0 items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  'gap-1.5 rounded-full px-3 py-1.5 font-normal',
                  hasChanges &&
                    'border-amber-500/40 text-amber-700 dark:text-amber-400',
                )}
              >
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    hasChanges ? 'bg-amber-500' : 'bg-emerald-500',
                  )}
                />
                {hasChanges ? '有未保存更改' : '与已保存配置一致'}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                aria-label="刷新配置"
                disabled={Boolean(busy)}
                onClick={() =>
                  hasChanges ? discard() : (void load(), void loadMachine())
                }
              >
                <RemixIcon name="refresh" />
              </Button>
            </div>
          </header>
          <div className="mb-7 grid grid-cols-3 divide-x rounded-xl border bg-muted/15 py-5">
            <div className="px-5">
              <p className="text-xs text-muted-foreground">已保存的启用连接</p>
              <p className="mt-1.5 text-2xl font-semibold tabular-nums">
                {data.connections.filter((c) => c.enabled).length}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  / {data.connections.length} 个
                </span>
              </p>
            </div>
            <div className="px-5">
              <p className="text-xs text-muted-foreground">已解析模型用途</p>
              <p className="mt-1.5 text-2xl font-semibold tabular-nums">
                {ready}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  / 11 项 · 尚需调用验证
                </span>
              </p>
            </div>
            <div className="px-5">
              <p className="text-xs text-muted-foreground">当前配置版本</p>
              <p className="mt-1.5 text-2xl font-semibold">
                {data.revision ? `v${data.revision}` : '待首次保存'}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {data.updatedAt
                  ? formatDate(data.updatedAt)
                  : '原有配置将随首次保存迁入'}
              </p>
            </div>
          </div>
          {error && (
            <div role="alert" className="mb-5">
              <Note tone="warning">{error}</Note>
            </div>
          )}
          {notice && (
            <div role="status" className="mb-5">
              <Note tone="success">{notice}</Note>
            </div>
          )}
          <div
            className="mb-6 flex gap-7 border-b"
            role="tablist"
            aria-label="模型配置分区"
          >
            {tabs.map((item) => (
              <button
                key={item.id}
                id={`model-tab-${item.id}`}
                type="button"
                role="tab"
                tabIndex={tab === item.id ? 0 : -1}
                onKeyDown={(e) => {
                  const index = tabs.findIndex((t) => t.id === item.id);
                  const next =
                    e.key === 'ArrowRight'
                      ? (index + 1) % tabs.length
                      : e.key === 'ArrowLeft'
                        ? (index + tabs.length - 1) % tabs.length
                        : e.key === 'Home'
                          ? 0
                          : e.key === 'End'
                            ? tabs.length - 1
                            : null;
                  if (next === null) return;
                  e.preventDefault();
                  setTab(tabs[next].id);
                  scrollArea.current?.scrollTo({ top: 0 });
                  document
                    .getElementById(`model-tab-${tabs[next].id}`)
                    ?.focus();
                }}
                aria-selected={tab === item.id}
                aria-controls={`model-panel-${item.id}`}
                onClick={() => {
                  setTab(item.id);
                  scrollArea.current?.scrollTo({ top: 0 });
                }}
                className={cn(
                  'relative flex items-center gap-2 pb-3 pt-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  tab === item.id
                    ? 'font-medium text-foreground after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:bg-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <RemixIcon name={item.icon} size="size-4" />
                {item.label}
                {item.id === 'machine' && machine?.pendingRestart && (
                  <span
                    className="size-1.5 rounded-full bg-amber-500"
                    aria-label="需要重启"
                  />
                )}
              </button>
            ))}
          </div>
          <section
            id={`model-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`model-tab-${tab}`}
          >
            {tab === 'connections' && (
              <Connections
                document={draft}
                onChange={setDraft}
                data={data}
                selected={selected}
                onSelect={setSelected}
                keys={keys}
                onKeys={setKeys}
                add={add}
                remove={remove}
                test={() => void testConnection()}
                testResult={currentTest}
                busy={busy}
              />
            )}
            {tab === 'assignments' && (
              <Assignments
                document={draft}
                onChange={setDraft}
                data={data}
                dirty={dirty}
                disabled={Boolean(busy)}
              />
            )}
            {tab === 'machine' && (
              <MachineSettings
                data={machine}
                updates={machineUpdates}
                onChange={setMachineUpdates}
                error={machineError}
                busy={busy}
                onReload={() => void loadMachine()}
              />
            )}
            {tab === 'history' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-base font-semibold">
                    每次更改，都有来处
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    保存与恢复都会生成新版本。历史包含连接密钥与用途分配，本机环境文件的备份独立保留。
                  </p>
                </div>
                {!data.history.length ? (
                  <div className="rounded-xl border border-dashed py-16 text-center">
                    <RemixIcon
                      name="history"
                      size="size-8"
                      className="mb-3 text-muted-foreground"
                    />
                    <p className="font-medium">尚无配置版本</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      首次保存后，可在这里查看记录和恢复历史配置。
                    </p>
                  </div>
                ) : (
                  <div className="divide-y overflow-hidden rounded-xl border">
                    {data.history.map((item) => (
                      <div
                        key={item.revision}
                        className="flex items-center gap-4 px-6 py-5"
                      >
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-muted/30 text-sm font-medium">
                          v{item.revision}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            {item.action === 'rollback'
                              ? `恢复自 v${item.restoredFrom}`
                              : '保存配置'}
                            {item.revision === data.revision && (
                              <Badge
                                variant="outline"
                                className="text-xs font-normal"
                              >
                                当前版本
                              </Badge>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {formatDate(item.createdAt)} ·{' '}
                            {item.connectionCount} 个连接 · 当前用户
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            Boolean(busy) ||
                            dirty ||
                            item.revision === data.revision
                          }
                          onClick={() => rollback(item.revision)}
                        >
                          恢复此版本
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {dirty && (
                  <Note tone="warning">
                    恢复历史前，请先保存或放弃当前草稿。
                  </Note>
                )}
                <Note>
                  测试只证明特定版本、连接和模型的文本响应。修改地址、协议、模型或密钥后，旧测试不能证明新配置可用。
                </Note>
              </div>
            )}
          </section>
        </div>
      </div>
      <footer className="shrink-0 border-t bg-background/95 px-6 py-4 xl:px-10">
        <div className="mx-auto flex max-w-[1160px] items-center justify-between gap-5">
          <div className="text-xs leading-5 text-muted-foreground">
            <span className={cn(dirty && 'text-amber-700 dark:text-amber-400')}>
              {tab === 'machine'
                ? Object.keys(machineUpdates).length
                  ? '本机服务有未保存的更改'
                  : '本机服务配置独立保存'
                : dirty
                  ? '连接与分配有未保存的更改'
                  : `已保存配置 · ${data.revision ? `v${data.revision}` : '尚未创建版本'}`}
            </span>
            <span className="ml-3">
              {tab === 'machine'
                ? '写入后需重启 Web 与 Worker'
                : '连接密钥加密存储 · 保存时检查版本冲突'}
            </span>
            {(tab === 'machine' ? machineError : error) && (
              <p
                role="alert"
                className="mt-1 max-w-2xl text-amber-700 dark:text-amber-400"
              >
                {tab === 'machine' ? machineError : error}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="ghost"
              disabled={!hasChanges || Boolean(busy)}
              onClick={discard}
            >
              放弃更改
            </Button>
            <Button
              disabled={
                Boolean(busy) ||
                (tab === 'machine'
                  ? !machine?.editable || !Object.keys(machineUpdates).length
                  : !dirty)
              }
              onClick={() => void (tab === 'machine' ? saveMachine() : save())}
            >
              {busy === 'save' || busy === 'machine'
                ? '保存中…'
                : tab === 'machine'
                  ? '保存本机服务配置'
                  : '保存连接与分配'}
            </Button>
          </div>
        </div>
      </footer>
      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmation?.title}</DialogTitle>
            <DialogDescription className="max-h-[50vh] overflow-y-auto whitespace-pre-line break-all leading-6">
              {confirmation?.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                const action = confirmation?.action;
                setConfirmation(null);
                action?.();
              }}
            >
              {confirmation?.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
