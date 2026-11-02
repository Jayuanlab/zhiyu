'use client';
import { Input } from '@openzhiyu/ui';
import {
  MODEL_PURPOSES,
  type ModelPurpose,
} from '@openzhiyu/shared/model-configuration';
import {
  MODEL_TIERS,
  assignmentProtocols,
  type ModelCenterDocument,
} from '@openzhiyu/shared/model-center';
import {
  ConfigurationState,
  Field,
  Note,
  protocolLabels,
  tierLabels,
  purposeDescriptions,
  sourceLabel,
  selectClass,
  type CenterData,
  type Effective,
} from './common';
export function Assignments({
  document,
  onChange,
  data,
  dirty,
  disabled,
}: {
  document: ModelCenterDocument;
  onChange: (d: ModelCenterDocument) => void;
  data: CenterData;
  dirty: boolean;
  disabled: boolean;
}) {
  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-base font-semibold">让每项能力使用合适的模型</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          显式分配优先于部署配置。停用用途会拒绝调用；停用被引用的连接也不会自动切换服务。
        </p>
      </div>
      {dirty && (
        <Note tone="warning">
          “当前生效”展示已保存配置。保存草稿后，会重新解析各用途的来源和模型。
        </Note>
      )}
      <div className="grid grid-cols-2 items-center gap-5 rounded-xl border p-5">
        <div>
          <p className="text-sm font-medium">Pi 执行器 · 多协议接入</p>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">
            对话使用“Pi 智能体执行”的分配；车间和 Loop
            再按档位选择。协议随服务连接保存，切换模型不会借用其他服务的密钥。
          </p>
        </div>
        <div className="min-w-0 border-l pl-5">
          <p className="mb-2 text-xs text-muted-foreground">当前对话配置</p>
          <ConfigurationState config={data.effective.conversation} />
          <p className="mt-2 truncate text-sm">
            {data.effective.conversation?.model ?? '尚未解析到模型'}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {sourceLabel(data.effective.conversation)}
          </p>
        </div>
      </div>
      <AssignmentTable>
        {(Object.keys(MODEL_PURPOSES) as ModelPurpose[]).map((purpose) => (
          <AssignmentRow
            key={purpose}
            assignmentKey={purpose}
            label={MODEL_PURPOSES[purpose].label}
            description={purposeDescriptions[purpose]}
            document={document}
            onChange={onChange}
            config={data.effective[purpose]}
            disabled={disabled}
          />
        ))}
      </AssignmentTable>
      <div>
        <h3 className="text-base font-semibold">智能体执行档位</h3>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          档位继承“Pi
          智能体执行”的分配，三种协议均可使用。模型名称本身不代表工具、视觉或业务任务能力验证。
        </p>
      </div>
      <AssignmentTable>
        {MODEL_TIERS.map((tier) => (
          <AssignmentRow
            key={tier}
            assignmentKey={`agent:${tier}`}
            label={tierLabels[tier].name}
            description={tierLabels[tier].description}
            document={document}
            onChange={onChange}
            config={data.effective.agent_tiers[tier]}
            disabled={disabled}
          />
        ))}
      </AssignmentTable>
      <Note>
        连接、默认项和用途分配作为同一版本保存。新请求读取新版本，已启动任务保留原快照。任务内选择模型不会改变连接地址和密钥。
      </Note>
    </div>
  );
}
function AssignmentTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[740px] text-left text-sm">
        <thead className="bg-muted/35 text-xs text-muted-foreground">
          <tr>
            <th className="w-1/4 px-5 py-3 font-medium">用途 / 档位</th>
            <th className="w-[27%] px-4 py-3 font-medium">服务连接</th>
            <th className="w-[23%] px-4 py-3 font-medium">模型选择</th>
            <th className="w-1/4 px-5 py-3 font-medium">当前生效 · 已保存</th>
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}
function AssignmentRow({
  assignmentKey,
  label,
  description,
  document,
  onChange,
  config,
  disabled,
}: {
  assignmentKey: string;
  label: string;
  description: string;
  document: ModelCenterDocument;
  onChange: (d: ModelCenterDocument) => void;
  config?: Effective;
  disabled: boolean;
}) {
  const assignment = document.assignments[assignmentKey] ?? {
      mode: 'inherit' as const,
    },
    protocols = assignmentProtocols(assignmentKey);
  const update = (value: string) =>
    onChange({
      ...document,
      assignments: {
        ...document.assignments,
        [assignmentKey]:
          value === 'inherit' || value === 'disabled'
            ? { mode: value }
            : { mode: 'connection', connectionId: value },
      },
    });
  return (
    <tr className="align-top">
      <td className="px-5 py-5">
        <p className="font-medium">{label}</p>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </td>
      <td className="px-4 py-5">
        <select
          aria-label={`${label}的服务连接`}
          className={selectClass}
          disabled={disabled}
          value={
            assignment.mode === 'connection'
              ? assignment.connectionId
              : assignment.mode
          }
          onChange={(e) => update(e.target.value)}
        >
          <option value="inherit">
            {assignmentKey.startsWith('agent:')
              ? '继承智能体执行配置'
              : '继承默认解析'}
          </option>
          <option value="disabled">停用此用途</option>
          {document.connections
            .filter((c) => protocols.includes(c.protocol))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {!c.enabled ? '（已停用）' : ''}
              </option>
            ))}
        </select>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {protocols.map((p) => protocolLabels[p]).join(' / ')}
        </p>
      </td>
      <td className="px-4 py-5">
        {assignment.mode === 'connection' ? (
          <Input
            aria-label={`${label}的模型 ID`}
            placeholder="留空使用连接默认模型"
            value={assignment.model ?? ''}
            maxLength={256}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...document,
                assignments: {
                  ...document.assignments,
                  [assignmentKey]: { ...assignment, model: e.target.value },
                },
              })
            }
          />
        ) : (
          <p className="py-3 text-xs text-muted-foreground">
            {assignment.mode === 'disabled'
              ? '拒绝该用途调用'
              : '随继承配置解析'}
          </p>
        )}
      </td>
      <td className="px-5 py-5">
        <ConfigurationState config={config} />
        <p className="mt-2 max-w-[250px] break-all text-xs leading-5">
          {config?.model ?? '—'}
        </p>
        <p className="mt-1 max-w-[250px] break-all text-[11px] leading-5 text-muted-foreground">
          {sourceLabel(config)}
        </p>
        {config?.revision && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {config.revision.startsWith('center:')
              ? `配置 v${config.revision.slice(7)}`
              : '部署 / 兼容配置'}
          </p>
        )}
      </td>
    </tr>
  );
}
