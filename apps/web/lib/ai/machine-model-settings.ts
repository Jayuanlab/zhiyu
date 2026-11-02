import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';
import { ModelCenterError } from '@openzhiyu/shared/model-center';
import { normalizeModelBaseUrl } from '@openzhiyu/shared/model-configuration';

const fields = [
  {
    key: 'EMBEDDING_PROVIDER',
    label: '运行方式',
    group: 'embedding',
    options: ['cloud', 'local'],
    placeholder: 'cloud',
  },
  {
    key: 'LLM_EMBEDDING_BASE_URL',
    label: '向量服务地址',
    group: 'embedding',
    url: true,
    placeholder: 'https://服务地址/v1',
  },
  {
    key: 'OPENAI_EMBEDDINGS_API_KEY',
    label: '向量服务密钥',
    group: 'embedding',
    secret: true,
  },
  {
    key: 'LLM_EMBEDDING_MODEL',
    label: '向量模型 ID',
    group: 'embedding',
    placeholder: '服务商提供的模型 ID',
  },
  {
    key: 'LLM_EMBEDDING_DIMENSIONS',
    label: '向量维度',
    group: 'embedding',
    placeholder: '留空使用模型默认值',
  },
  {
    key: 'LLM_EMBEDDING_API_FORMAT',
    label: '向量接口格式',
    group: 'embedding',
    options: ['openai', 'dashscope'],
    placeholder: 'openai',
  },
  {
    key: 'LOCAL_EMBEDDING_MODEL',
    label: '本地向量模型',
    group: 'embedding',
    placeholder: 'Xenova/all-MiniLM-L6-v2',
  },
  {
    key: 'AUDIO_PROVIDER',
    label: '语音服务提供者',
    group: 'audio',
    options: ['openai', 'bailian'],
    placeholder: 'openai',
  },
  {
    key: 'AUDIO_BASE_URL',
    label: '语音服务地址',
    group: 'audio',
    url: true,
    placeholder: '百炼：https://dashscope.aliyuncs.com/api/v1',
  },
  {
    key: 'AUDIO_API_KEY',
    label: '语音服务密钥',
    group: 'audio',
    secret: true,
  },
  {
    key: 'OPENAI_AUDIO_BASE_URL',
    legacy: true,
    label: '音频服务地址',
    group: 'audio',
    url: true,
    placeholder: 'https://api.openai.com/v1',
  },
  {
    key: 'OPENAI_API_KEY',
    legacy: true,
    label: '音频服务密钥',
    group: 'audio',
    secret: true,
  },
  {
    key: 'AUDIO_TTS_MODEL',
    label: '语音合成模型 ID',
    group: 'audio',
    placeholder: '百炼：qwen-audio-3.1-tts-flash',
  },
  {
    key: 'AUDIO_TTS_VOICE',
    label: '合成音色',
    group: 'audio',
    placeholder: '百炼：longanhuan_v3.1；OpenAI：alloy',
  },
  {
    key: 'AUDIO_ASR_MODEL',
    label: '语音识别模型 ID',
    group: 'audio',
    placeholder: '百炼：qwen3-asr-flash',
  },
  {
    key: 'AI_VIDEO_AGENT_VIDEO_BASE_URL',
    label: '视频服务地址',
    group: 'video',
    url: true,
    placeholder: 'https://dashscope.aliyuncs.com/api/v1',
  },
  {
    key: 'AI_VIDEO_AGENT_VIDEO_ENDPOINT',
    label: '自定义视频提交接口（可选）',
    group: 'video',
    url: true,
    placeholder: '留空使用服务默认接口',
  },
  {
    key: 'AI_VIDEO_AGENT_VIDEO_API_KEY',
    label: '视频服务密钥',
    group: 'video',
    secret: true,
  },
  {
    key: 'AI_VIDEO_AGENT_VIDEO_MODEL',
    label: '视频模型 ID',
    group: 'video',
    placeholder: '服务商提供的模型 ID',
  },
  {
    key: 'AI_VIDEO_AGENT_VIDEO_REGION',
    label: '视频区域（可选）',
    group: 'video',
    placeholder: 'cn-beijing',
  },
] as const;
type Field = {
  key: string;
  label: string;
  group: string;
  secret?: boolean;
  url?: boolean;
  options?: readonly string[];
  placeholder?: string;
  legacy?: boolean;
};
const descriptors: readonly Field[] = fields;
export const machineModelFields = descriptors;
export const machineModelRoot = () =>
  resolve(process.env.ZHIYU_MACHINE_MODEL_ROOT || process.cwd());
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const audioKey = (env: Record<string, string | undefined>) =>
  'AUDIO_API_KEY' in env
    ? env.AUDIO_API_KEY || ''
    : !env.AUDIO_PROVIDER || env.AUDIO_PROVIDER === 'openai'
      ? env.OPENAI_API_KEY || ''
      : '';
async function readOptional(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export async function readMachineModelSettings(
  editable: boolean,
  root = machineModelRoot(),
) {
  const content = await readOptional(join(root, '.env')),
    saved = parse(content);
  const overridden: Record<string, string> = {};
  for (const file of [
    `.env.${process.env.NODE_ENV ?? 'development'}.local`,
    '.env.local',
    `.env.${process.env.NODE_ENV ?? 'development'}`,
  ]) {
    for (const key of Object.keys(parse(await readOptional(join(root, file)))))
      overridden[key] ??= file;
  }
  const items = descriptors.map((field) => ({
    ...field,
    value: field.secret
      ? ''
      : (saved[field.key] ??
        (field.key === 'AUDIO_BASE_URL' &&
        (!saved.AUDIO_PROVIDER || saved.AUDIO_PROVIDER === 'openai')
          ? saved.OPENAI_AUDIO_BASE_URL
          : '') ??
        ''),
    hasValue: Boolean(
      field.key === 'AUDIO_API_KEY' ? audioKey(saved) : saved[field.key],
    ),
    activeValue: field.secret ? undefined : (process.env[field.key] ?? ''),
    activeHasValue: Boolean(
      field.key === 'AUDIO_API_KEY'
        ? audioKey(process.env)
        : process.env[field.key],
    ),
    pending:
      field.key === 'AUDIO_API_KEY'
        ? audioKey(saved) !== audioKey(process.env)
        : (saved[field.key] ?? '') !== (process.env[field.key] ?? ''),
    sourceHint:
      field.key === 'AUDIO_API_KEY' &&
      !('AUDIO_API_KEY' in saved) &&
      audioKey(saved)
        ? '正在兼容原有音频密钥；填写后改为独立语音密钥。'
        : undefined,
    overriddenBy: overridden[field.key],
  }));
  return {
    revision: digest(content),
    editable,
    fields: items,
    observedAt: new Date().toISOString(),
    pendingRestart: items.some((item) => item.pending),
    scope: 'deployment',
    file: 'apps/web/.env',
  };
}

/** Whitelisted, optimistic, atomic file replacement. Never mutate one process's env. */
export async function saveMachineModelSettings(
  input: {
    expectedRevision: string;
    updates: Record<string, string | null>;
    actor: string;
  },
  root = machineModelRoot(),
) {
  const directory = join(root, '.runtime', 'model-config');
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, 'write.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new ModelCenterError('machine_configuration_busy', undefined, 409);
    throw error;
  }
  let temp: string | undefined;
  try {
    const path = join(root, '.env'),
      content = await readOptional(path);
    if (digest(content) !== input.expectedRevision)
      throw new ModelCenterError('configuration_conflict', undefined, 409);
    const state = await readMachineModelSettings(true, root);
    const updates = validateMachineModelUpdates(
      input.updates,
      parse(content),
      state,
    );
    if (!Object.keys(updates).length) return state;
    const keys = new Set(Object.keys(updates));
    const lines = content
      .split(/\r?\n/)
      .filter(
        (line) =>
          !keys.has(
            line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/)?.[1] ?? '',
          ),
      );
    while (lines.at(-1) === '') lines.pop();
    for (const [key, value] of Object.entries(updates))
      if (value !== null) lines.push(`${key}="${value}"`);
    const next = lines.join('\n') + '\n',
      id = randomUUID();
    await writeFile(join(directory, `${id}.before.env`), content, {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(
      join(directory, `${id}.json`),
      JSON.stringify({
        actor: input.actor,
        createdAt: new Date().toISOString(),
        before: digest(content),
        after: digest(next),
        fields: [...keys],
      }),
      { mode: 0o600, flag: 'wx' },
    );
    temp = join(root, `.env.model-${id}.tmp`);
    await writeFile(temp, next, { mode: 0o600, flag: 'wx' });
    if (digest(await readOptional(path)) !== input.expectedRevision)
      throw new ModelCenterError('configuration_conflict', undefined, 409);
    await rename(temp, path);
    temp = undefined;
    return readMachineModelSettings(true, root);
  } finally {
    if (temp) await unlink(temp).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

export function validateMachineModelUpdates(
  requested: Record<string, string | null>,
  saved: Record<string, string>,
  state: Awaited<ReturnType<typeof readMachineModelSettings>>,
  credentialEnv: Record<string, string | undefined> = process.env,
) {
  const updates: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(requested)) {
    const field = descriptors.find((item) => item.key === key);
    if (!field) throw new ModelCenterError('machine_field_denied', key);
    if (state.fields.find((item) => item.key === key)?.overriddenBy)
      throw new ModelCenterError('machine_field_overridden', key);
    if (value !== null && /[\r\n"\\$]/.test(value))
      throw new ModelCenterError('invalid_machine_value', key);
    const next = value?.trim() || null;
    if (field.options && next && !field.options.includes(next))
      throw new ModelCenterError('invalid_machine_value', key);
    if (field.url && next) normalizeModelBaseUrl(next, 'machine');
    if (
      key === 'LLM_EMBEDDING_DIMENSIONS' &&
      next &&
      (!/^\d+$/.test(next) || Number(next) < 1 || Number(next) > 65536)
    )
      throw new ModelCenterError('invalid_machine_value', key);
    // An empty password field means retain. Explicit null means clear.
    if (field.secret && value === '') continue;
    updates[key] = key === 'AUDIO_API_KEY' && value === null ? '' : next;
  }
  // Prevent an old dedicated credential from travelling to a changed service.
  const previous = saved;
  if (
    previous.AUDIO_API_KEY &&
    'OPENAI_AUDIO_BASE_URL' in updates &&
    !previous.AUDIO_BASE_URL &&
    (updates.OPENAI_AUDIO_BASE_URL ?? '') !==
      (previous.OPENAI_AUDIO_BASE_URL ?? '') &&
    !updates.AUDIO_API_KEY
  )
    throw new ModelCenterError('host_change_requires_key', 'AUDIO_API_KEY');
  for (const [urls, key, aliases] of [
    [
      ['LLM_EMBEDDING_BASE_URL'],
      'OPENAI_EMBEDDINGS_API_KEY',
      [
        'DASHSCOPE_API_KEY',
        'BAILIAN_API_KEY',
        'ALIBABA_CLOUD_API_KEY',
        'OPENROUTER_API_KEY',
        'LLM_API_KEY',
      ],
    ],
    [['OPENAI_AUDIO_BASE_URL'], 'OPENAI_API_KEY', []],
    [['AUDIO_BASE_URL', 'AUDIO_PROVIDER'], 'AUDIO_API_KEY', ['OPENAI_API_KEY']],
    [
      ['AI_VIDEO_AGENT_VIDEO_BASE_URL', 'AI_VIDEO_AGENT_VIDEO_ENDPOINT'],
      'AI_VIDEO_AGENT_VIDEO_API_KEY',
      [
        'AI_VIDEO_AGENT_WAN_API_KEY',
        'BAILIAN_VIDEO_API_KEY',
        'DASHSCOPE_API_KEY',
        'BAILIAN_API_KEY',
      ],
    ],
  ] as const)
    if (
      [key, ...aliases].some((name) => previous[name] || credentialEnv[name]) &&
      urls.some(
        (url) =>
          url in updates && (updates[url] ?? '') !== (previous[url] ?? ''),
      ) &&
      !updates[key]
    )
      throw new ModelCenterError('host_change_requires_key', key);
  return updates;
}

export async function machineTestEnvironment(
  input: {
    expectedRevision: string;
    updates: Record<string, string | null>;
    source?: 'draft' | 'runtime';
  },
  root = machineModelRoot(),
) {
  const content = await readOptional(join(root, '.env'));
  if (digest(content) !== input.expectedRevision)
    throw new ModelCenterError('configuration_conflict', undefined, 409);
  const state = await readMachineModelSettings(true, root),
    saved = parse(content);
  if (input.source === 'runtime') {
    if (Object.keys(input.updates).length)
      throw new ModelCenterError('runtime_test_has_draft');
    return {
      env: { ...process.env },
      revision: input.expectedRevision,
      source: 'runtime' as const,
      pendingRestart: state.pendingRestart,
    };
  }
  const overlay: Record<string, string> = {};
  for (const file of [
    `.env.${process.env.NODE_ENV ?? 'development'}`,
    '.env.local',
    `.env.${process.env.NODE_ENV ?? 'development'}.local`,
  ])
    Object.assign(overlay, parse(await readOptional(join(root, file))));
  const updates = validateMachineModelUpdates(input.updates, saved, state, {
    ...saved,
    ...overlay,
  });
  let env: Record<string, string | undefined> = { ...saved };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  env = { ...env, ...overlay };
  return {
    env,
    revision: input.expectedRevision,
    source: 'draft' as const,
    pendingRestart: state.pendingRestart || Object.keys(updates).length > 0,
  };
}
