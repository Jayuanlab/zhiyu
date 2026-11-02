import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  CloudEmbeddingProvider,
  LocalTransformersEmbeddingProvider,
  getCloudEmbeddingConfiguration,
  getConfiguredEmbeddingDimensions,
  resolveEmbeddingApiFormat,
} from '@openzhiyu/rag';
import {
  encryptToken,
  decryptToken,
} from '@openzhiyu/security/token-encryption';
import {
  SpeechService,
  resolveAudioConfiguration,
  MediaServiceError,
  downloadProviderMedia,
  readLimited,
} from '@openzhiyu/ai/audio';
import { ModelCenterError } from '@openzhiyu/shared/model-center';
import { normalizeModelBaseUrl } from '@openzhiyu/shared/model-configuration';
import {
  submitBailianVideoTask,
  queryBailianVideoTask,
  resolveBailianVideoConnection,
} from '@/lib/video/bailian-video-client';
import {
  machineModelFields,
  machineModelRoot,
  machineTestEnvironment,
} from './machine-model-settings';

export type MachineTestKind =
  | 'embedding'
  | 'speech'
  | 'transcription'
  | 'video';
export type MachineServiceTest = {
  id: string;
  ownerId: string;
  kind: MachineTestKind;
  source: 'draft' | 'runtime';
  revision: string;
  fingerprint: string;
  requestHash: string;
  state: 'running' | 'pending' | 'passed' | 'failed' | 'unconfirmed';
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  baseUrl: string;
  detail: string;
  httpStatus?: number;
  taskId?: string;
  providerStatus?: string;
  dimensions?: number;
  vectorCount?: number;
  text?: string;
  mediaType?: string;
  mediaBytes?: number;
  mediaHash?: string;
  encryptedConfig: string;
  encryptedMediaUrl?: string;
};
const TEST_TEXT = '你好，这是知遇的语音测试。';
const active = (record: MachineServiceTest) =>
  ['running', 'pending', 'unconfirmed'].includes(record.state);
const now = () => new Date().toISOString();
const sha = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
async function claimLock(file: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, at: Date.now() }),
        );
        return handle;
      } catch (error) {
        await handle.close();
        await unlink(file).catch(() => {});
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let dead = false;
      try {
        const previous = JSON.parse(await readFile(file, 'utf8'));
        try {
          process.kill(previous.pid, 0);
        } catch {
          dead = true;
        }
      } catch {
        dead = Date.now() - (await stat(file)).mtimeMs > 120000;
      }
      if (!dead) return null;
      await unlink(file).catch(() => {});
    }
  }
  return null;
}
function paths(id: string, root: string) {
  if (!idPattern.test(id))
    throw new ModelCenterError('machine_test_not_found', undefined, 404);
  const dir = join(root, '.runtime', 'model-config', 'service-tests');
  return {
    dir,
    record: join(dir, id + '.json'),
    media: join(dir, id + '.media'),
    lock: join(dir, id + '.lock'),
  };
}
export function safeMachineServiceTest(record: MachineServiceTest) {
  const { ownerId, encryptedConfig, encryptedMediaUrl, requestHash, ...safe } =
    record;
  return {
    ...safe,
    passed: record.state === 'passed',
    mediaUrl: record.mediaHash
      ? `/api/preferences/models/machine/tests/${record.id}/media`
      : undefined,
  };
}
async function readRecord(id: string, owner: string, root: string) {
  let record: MachineServiceTest;
  try {
    record = JSON.parse(await readFile(paths(id, root).record, 'utf8'));
  } catch {
    throw new ModelCenterError('machine_test_not_found', undefined, 404);
  }
  if (record.ownerId !== owner)
    throw new ModelCenterError('machine_test_not_found', undefined, 404);
  return record;
}
async function recordEvent(record: MachineServiceTest, root: string) {
  await appendFile(
    join(paths(record.id, root).dir, record.id + '.events.jsonl'),
    JSON.stringify({
      id: record.id,
      ownerId: record.ownerId,
      kind: record.kind,
      state: record.state,
      source: record.source,
      revision: record.revision,
      fingerprint: record.fingerprint,
      taskId: record.taskId,
      providerStatus: record.providerStatus,
      detail: record.detail,
      httpStatus: record.httpStatus,
      mediaHash: record.mediaHash,
      at: record.updatedAt,
    }) + '\n',
    { mode: 0o600 },
  );
}
async function saveRecord(record: MachineServiceTest, root: string) {
  const path = paths(record.id, root).record,
    temp = path + '.' + randomUUID() + '.tmp';
  record.updatedAt = now();
  await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  try {
    await recordEvent(record, root);
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function listMachineServiceTests(
  owner: string,
  root = machineModelRoot(),
  limit = 30,
) {
  const dir = paths(randomUUID(), root).dir;
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(
    files
      .filter(
        (file) => idPattern.test(file.slice(0, -5)) && file.endsWith('.json'),
      )
      .map(async (file) => {
        try {
          return await readRecord(file.slice(0, -5), owner, root);
        } catch {
          return undefined;
        }
      }),
  );
  return records
    .filter((record): record is MachineServiceTest => Boolean(record))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
function failure(error: unknown): { detail: string; httpStatus?: number } {
  if (error instanceof MediaServiceError)
    return { detail: error.code, httpStatus: error.status };
  if (
    error instanceof Error &&
    ['AbortError', 'TimeoutError'].includes(error.name)
  )
    return { detail: 'machine_test_aborted_or_timed_out' };
  if (
    error instanceof Error &&
    /^embedding_(?:provider_http_\d+|response_invalid_dimensions_or_values)$/.test(
      error.message,
    )
  )
    return { detail: error.message };
  return { detail: 'machine_test_provider_failed' };
}
function embeddingConfig(env: Record<string, string | undefined>) {
  if (env.EMBEDDING_PROVIDER === 'local')
    return {
      provider: 'local',
      modelName: env.LOCAL_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
      baseURL: 'local',
      apiKey: '',
      apiFormat: 'openai' as const,
      dimensions: null,
    };
  if (
    env.LLM_EMBEDDING_DIMENSIONS &&
    (!/^\d+$/.test(env.LLM_EMBEDDING_DIMENSIONS) ||
      Number(env.LLM_EMBEDDING_DIMENSIONS) < 1 ||
      Number(env.LLM_EMBEDDING_DIMENSIONS) > 65536)
  )
    throw new ModelCenterError(
      'invalid_machine_value',
      'LLM_EMBEDDING_DIMENSIONS',
    );
  const config = getCloudEmbeddingConfiguration({ env });
  if (!config.apiKey)
    throw new ModelCenterError(
      'machine_test_key_required',
      'OPENAI_EMBEDDINGS_API_KEY',
    );
  return {
    ...config,
    provider: 'cloud',
    apiFormat: resolveEmbeddingApiFormat(config.modelName, env),
    dimensions: getConfiguredEmbeddingDimensions(config.modelName, env) ?? null,
    parameters: {
      textType: env.LLM_EMBEDDING_TEXT_TYPE,
      outputType: env.LLM_EMBEDDING_OUTPUT_TYPE,
      instruct: env.LLM_EMBEDDING_INSTRUCT,
    },
  };
}
async function storeMedia(
  record: MachineServiceTest,
  bytes: Uint8Array,
  mimeType: string,
  root: string,
) {
  const path = paths(record.id, root).media,
    temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
  try {
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
  record.mediaType = mimeType;
  record.mediaBytes = bytes.byteLength;
  record.mediaHash = sha(bytes);
}
export async function readMachineTestMedia(
  id: string,
  owner: string,
  root = machineModelRoot(),
) {
  const record = await readRecord(id, owner, root);
  if (record.state !== 'passed' || !record.mediaHash)
    throw new ModelCenterError(
      'machine_test_media_unavailable',
      undefined,
      404,
    );
  const bytes = await readFile(paths(id, root).media);
  if (sha(bytes) !== record.mediaHash)
    throw new ModelCenterError('machine_test_media_changed', undefined, 409);
  return { bytes, mimeType: record.mediaType! };
}
export type MachineTestInput = {
  id: string;
  kind: MachineTestKind;
  expectedRevision: string;
  updates: Record<string, string | null>;
  source?: 'draft' | 'runtime';
  audioBase64?: string;
};
export async function startMachineServiceTest(
  owner: string,
  input: MachineTestInput,
  signal?: AbortSignal,
  root = machineModelRoot(),
) {
  const group =
    input.kind === 'embedding'
      ? 'embedding'
      : input.kind === 'video'
        ? 'video'
        : 'audio';
  if (
    Object.keys(input.updates).some(
      (key) =>
        !machineModelFields.some(
          (field) => field.key === key && field.group === group,
        ),
    )
  )
    throw new ModelCenterError('machine_field_denied');
  const snapshot = await machineTestEnvironment(input, root);
  const env = snapshot.env;
  // Resolve dedicated aliases without crossing service identities.
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value && /^\$[A-Z0-9_]+$/.test(value)) env[key] = env[value.slice(1)];
  }
  const connection =
    input.kind === 'embedding'
      ? embeddingConfig(env)
      : input.kind === 'video'
        ? resolveBailianVideoConnection(env)
        : resolveAudioConfiguration(env);
  if (
    !connection.apiKey &&
    !(
      input.kind === 'embedding' &&
      (connection as ReturnType<typeof embeddingConfig>).provider === 'local'
    )
  )
    throw new ModelCenterError('machine_test_key_required');
  const fingerprint = createHmac('sha256', process.env.ENCRYPTION_KEY || '')
    .update(JSON.stringify({ kind: input.kind, connection }))
    .digest('hex');
  const requestHash = sha(
    JSON.stringify({
      fingerprint,
      audioHash: input.audioBase64 ? sha(input.audioBase64) : null,
      revision: input.expectedRevision,
      source: snapshot.source,
    }),
  );
  const location = paths(input.id, root);
  await mkdir(location.dir, { recursive: true, mode: 0o700 });
  try {
    const existing = await readRecord(input.id, owner, root);
    if (existing.requestHash !== requestHash)
      throw new ModelCenterError(
        'machine_test_request_conflict',
        undefined,
        409,
      );
    return existing;
  } catch (error) {
    if (
      !(error instanceof ModelCenterError) ||
      error.code !== 'machine_test_not_found'
    )
      throw error;
  }
  const record: MachineServiceTest = {
    id: input.id,
    ownerId: owner,
    kind: input.kind,
    source: snapshot.source,
    revision: snapshot.revision,
    fingerprint,
    requestHash,
    state: 'running',
    createdAt: now(),
    updatedAt: now(),
    provider: 'provider' in connection ? connection.provider : 'bailian',
    model:
      'modelName' in connection
        ? connection.modelName
        : 'ttsModel' in connection
          ? input.kind === 'speech'
            ? connection.ttsModel
            : connection.asrModel
          : connection.model,
    baseUrl: 'baseURL' in connection ? connection.baseURL : connection.baseUrl,
    detail: 'machine_test_running',
    encryptedConfig: encryptToken(JSON.stringify(connection)),
  };
  const admission = join(
    location.dir,
    sha(owner + input.kind) + '.admission.lock',
  );
  let admissionLock;
  admissionLock = await claimLock(admission);
  if (!admissionLock)
    throw new ModelCenterError('machine_test_busy', undefined, 409);
  try {
    const existing = (
      await listMachineServiceTests(owner, root, Number.POSITIVE_INFINITY)
    ).find(
      (test) =>
        test.id !== record.id &&
        test.fingerprint === fingerprint &&
        (test.kind === 'video'
          ? active(test) &&
            Date.now() - Date.parse(test.updatedAt) < 30 * 60 * 1000
          : test.state === 'running' &&
            Date.now() - Date.parse(test.createdAt) < 120000),
    );
    if (existing)
      throw new ModelCenterError(
        'machine_test_already_running',
        existing.id,
        409,
      );
    try {
      await writeFile(location.record, JSON.stringify(record), {
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const previous = await readRecord(input.id, owner, root);
        if (previous.requestHash !== requestHash)
          throw new ModelCenterError(
            'machine_test_request_conflict',
            undefined,
            409,
          );
        return previous;
      }
      throw error;
    }
    await recordEvent(record, root);
  } finally {
    await admissionLock.close();
    await unlink(admission).catch(() => {});
  }
  let submitted = false;
  try {
    signal?.throwIfAborted();
    if (input.kind === 'video') {
      submitted = true;
      const result = await submitBailianVideoTask(
        {
          prompt: '一只小猫坐在窗边，柔和日光，固定镜头。',
          resolution: '720P',
          durationSeconds: 5,
          ratio: '16:9',
          watermark: true,
          promptExtend: false,
        },
        connection as ReturnType<typeof resolveBailianVideoConnection>,
        signal,
      );
      record.taskId = result.taskId;
      record.state = 'pending';
      record.providerStatus = 'PENDING';
      record.detail = 'video_task_submitted';
    } else if (input.kind === 'embedding') {
      const config = connection as ReturnType<typeof embeddingConfig>;
      // Local model identity is constructor-bound too; no env mutation for tests.
      const provider =
        config.provider === 'local'
          ? new LocalTransformersEmbeddingProvider({
              modelName: config.modelName,
            })
          : new CloudEmbeddingProvider({ ...config, signal, env });
      const vectors = await provider.embedDocuments([
        '知遇向量连接测试。',
        '这是一段不同的检索测试文字。',
      ]);
      const dimensions = vectors[0]?.length;
      if (
        vectors.length !== 2 ||
        !dimensions ||
        vectors.some(
          (vector) =>
            vector.length !== dimensions ||
            !vector.every(Number.isFinite) ||
            !vector.some((value) => value !== 0),
        ) ||
        vectors[0].every((value, index) => value === vectors[1][index]) ||
        (config.dimensions !== null && dimensions !== config.dimensions)
      )
        throw new MediaServiceError('embedding_response_invalid');
      record.dimensions = dimensions;
      record.vectorCount = vectors.length;
      record.state = 'passed';
      record.detail = 'embedding_vectors_verified';
    } else {
      const service = new SpeechService(
        connection as ReturnType<typeof resolveAudioConfiguration>,
      );
      if (input.kind === 'speech') {
        const result = await service.synthesize(TEST_TEXT, signal);
        await storeMedia(record, result.bytes, result.mimeType, root);
        record.text = TEST_TEXT;
        record.detail = 'speech_audio_verified_listen_to_confirm';
      } else {
        if (
          !input.audioBase64 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(input.audioBase64) ||
          input.audioBase64.length > 12 * 1024 * 1024
        )
          throw new MediaServiceError('audio_input_invalid');
        const result = await service.transcribe(
          Buffer.from(input.audioBase64, 'base64'),
          signal,
        );
        record.text = result.text;
        record.detail = 'transcription_text_received_review_accuracy';
      }
      record.state = 'passed';
    }
    signal?.throwIfAborted();
    await saveRecord(record, root);
    return record;
  } catch (error) {
    Object.assign(record, failure(error));
    const rejected =
      error instanceof MediaServiceError &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status < 500;
    record.state = submitted && !rejected ? 'unconfirmed' : 'failed';
    if (submitted && !rejected && !record.taskId)
      record.detail = 'video_submission_unconfirmed';
    await saveRecord(record, root);
    return record;
  }
}
export async function pollMachineServiceTest(
  id: string,
  owner: string,
  signal?: AbortSignal,
  root = machineModelRoot(),
) {
  let record = await readRecord(id, owner, root);
  if (
    record.state === 'running' &&
    Date.now() - Date.parse(record.createdAt) > 120000
  ) {
    record.state = 'unconfirmed';
    record.detail = 'machine_test_process_interrupted';
    await saveRecord(record, root);
  }
  if (record.kind !== 'video' || !record.taskId || !active(record))
    return record;
  const location = paths(id, root),
    lock = await claimLock(location.lock);
  if (!lock) return record;
  try {
    record = await readRecord(id, owner, root);
    if (!active(record)) return record;
    const connection = JSON.parse(decryptToken(record.encryptedConfig));
    const result = await queryBailianVideoTask(
      record.taskId!,
      connection,
      signal,
    );
    record.providerStatus = result.status;
    if (result.status === 'SUCCEEDED') {
      if (!result.videoUrl)
        throw new MediaServiceError('video_completed_without_media');
      record.encryptedMediaUrl = encryptToken(result.videoUrl);
      const media = await downloadProviderMedia(
        result.videoUrl,
        connection.baseUrl,
        signal,
        64 * 1024 * 1024,
      );
      if (
        media.bytes.length < 64 ||
        new TextDecoder().decode(media.bytes.slice(4, 8)) !== 'ftyp'
      )
        throw new MediaServiceError('video_bytes_invalid');
      await storeMedia(record, media.bytes, 'video/mp4', root);
      record.state = 'passed';
      record.detail = 'video_completed_media_verified';
    } else if (['FAILED', 'CANCELED'].includes(result.status)) {
      record.state = 'failed';
      record.detail = 'video_provider_task_' + result.status.toLowerCase();
    } else {
      record.state = 'pending';
      record.detail =
        result.status === 'UNKNOWN'
          ? 'video_provider_status_unknown'
          : 'video_task_' + result.status.toLowerCase();
    }
    await saveRecord(record, root);
    return record;
  } catch (error) {
    Object.assign(record, failure(error));
    record.state = 'unconfirmed';
    await saveRecord(record, root);
    return record;
  } finally {
    await lock.close();
    await unlink(location.lock).catch(() => {});
  }
}
export async function readMachineTestJson(request: Request) {
  const bytes = await readLimited(new Response(request.body), 13 * 1024 * 1024);
  return JSON.parse(new TextDecoder().decode(bytes));
}
