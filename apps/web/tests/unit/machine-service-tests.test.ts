import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  startModelMediaFixture,
  fixtureWav,
} from '../../scripts/model-media-fixture.mjs';
import {
  readMachineModelSettings,
  machineTestEnvironment,
  saveMachineModelSettings,
} from '@/lib/ai/machine-model-settings';
import {
  startMachineServiceTest,
  pollMachineServiceTest,
  safeMachineServiceTest,
  readMachineTestMedia,
  listMachineServiceTests,
} from '@/lib/ai/machine-service-tests';
import {
  resolveAudioConfiguration,
  validateMediaUrl,
} from '@openzhiyu/ai/audio';
let fixture: Awaited<ReturnType<typeof startModelMediaFixture>>,
  root: string,
  revision: string;
const owner = 'synthetic-owner';
beforeAll(async () => {
  fixture = await startModelMediaFixture({ listen: false });
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(async () => {
  vi.stubGlobal('fetch', fixture.fetch);
  vi.stubEnv('ENCRYPTION_KEY', 'fixture-test-key-for-local-media-only');
  root = await mkdtemp(join(tmpdir(), 'zhiyu-media-test-'));
  await writeFile(
    join(root, '.env'),
    [
      'EMBEDDING_PROVIDER=cloud',
      `LLM_EMBEDDING_BASE_URL=${fixture.baseUrl}/compatible-mode/v1`,
      'OPENAI_EMBEDDINGS_API_KEY=private-embedding-key',
      'LLM_EMBEDDING_MODEL=text-embedding-v4',
      'LLM_EMBEDDING_DIMENSIONS=3',
      'LLM_EMBEDDING_API_FORMAT=openai',
      'AUDIO_PROVIDER=bailian',
      `AUDIO_BASE_URL=${fixture.baseUrl}/api/v1`,
      'AUDIO_API_KEY=private-speech-key',
      'AUDIO_TTS_MODEL=qwen-audio-3.1-tts-flash',
      'AUDIO_TTS_VOICE=longanhuan_v3.1',
      'AUDIO_ASR_MODEL=qwen3-asr-flash',
      `AI_VIDEO_AGENT_VIDEO_BASE_URL=${fixture.baseUrl}/api/v1`,
      'AI_VIDEO_AGENT_VIDEO_API_KEY=private-video-key',
      'AI_VIDEO_AGENT_VIDEO_MODEL=wan2.7-t2v-2026-06-12',
      'OTHER_SETTING=preserved',
    ].join('\n'),
  );
  revision = (await readMachineModelSettings(true, root)).revision;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (root.startsWith(join(tmpdir(), 'zhiyu-media-test-')))
    await rm(root, { recursive: true, force: true });
});
const input = (
  kind: 'embedding' | 'speech' | 'transcription' | 'video',
  updates: Record<string, string | null> = {},
) => ({ id: randomUUID(), kind, expectedRevision: revision, updates });
describe('shared media adapters with an isolated protocol fixture', () => {
  it('upgrades documented Alibaba HTTP media URLs without trusting lookalike hosts', () => {
    expect(
      validateMediaUrl(
        'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav?signature=fixture',
        'https://dashscope.aliyuncs.com/api/v1',
      ).protocol,
    ).toBe('https:');
    expect(() =>
      validateMediaUrl(
        'https://aliyuncs.com.foreign.invalid/audio.wav',
        fixture.baseUrl,
      ),
    ).toThrow('media_url_untrusted');
  });
  it('isolates Bailian credentials and preserves explicit clears across legacy fallback', async () => {
    expect(
      resolveAudioConfiguration({
        AUDIO_PROVIDER: 'bailian',
        OPENAI_API_KEY: 'unrelated-text-key',
      }).apiKey,
    ).toBe('');
    expect(
      resolveAudioConfiguration({ OPENAI_API_KEY: 'legacy-audio-key' }).apiKey,
    ).toBe('legacy-audio-key');
    expect(
      resolveAudioConfiguration({
        AUDIO_API_KEY: '',
        OPENAI_API_KEY: 'legacy-audio-key',
      }).apiKey,
    ).toBe('');
    const saved = await saveMachineModelSettings(
      {
        expectedRevision: revision,
        updates: { AUDIO_API_KEY: null },
        actor: owner,
      },
      root,
    );
    expect(
      (
        await machineTestEnvironment(
          { expectedRevision: saved.revision, updates: {} },
          root,
        )
      ).env.AUDIO_API_KEY,
    ).toBe('');
    await expect(
      startMachineServiceTest(
        owner,
        { ...input('speech'), expectedRevision: saved.revision },
        undefined,
        root,
      ),
    ).rejects.toThrow('machine_test_key_required');
  });
  it('does not dispatch when its initial audit event cannot be written', async () => {
    const request = input('speech'),
      dir = join(root, '.runtime/model-config/service-tests');
    await mkdir(join(dir, request.id + '.events.jsonl'), { recursive: true });
    const before = fixture.observed.length;
    await expect(
      startMachineServiceTest(owner, request, undefined, root),
    ).rejects.toThrow();
    expect(fixture.observed.length).toBe(before);
  });
  it('recovers a dead polling lock and refuses media altered after verification', async () => {
    const pending = await startMachineServiceTest(
        owner,
        input('video'),
        undefined,
        root,
      ),
      dir = join(root, '.runtime/model-config/service-tests');
    await writeFile(
      join(dir, pending.id + '.lock'),
      JSON.stringify({ pid: 2147483646, at: Date.now() }),
    );
    expect(
      (await pollMachineServiceTest(pending.id, owner, undefined, root)).state,
    ).toBe('pending');
    const completed = await pollMachineServiceTest(
      pending.id,
      owner,
      undefined,
      root,
    );
    expect(completed.state).toBe('passed');
    await writeFile(join(dir, pending.id + '.media'), 'replaced');
    await expect(readMachineTestMedia(pending.id, owner, root)).rejects.toThrow(
      'machine_test_media_changed',
    );
  });
  it('tests vector count, values and dimensions without writing configuration or an index', async () => {
    const before = await readFile(join(root, '.env'), 'utf8');
    const test = await startMachineServiceTest(
      owner,
      input('embedding'),
      undefined,
      root,
    );
    expect(test).toMatchObject({
      state: 'passed',
      dimensions: 3,
      vectorCount: 2,
    });
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(before);
    const sent = fixture.observed.findLast((request) =>
      request.path.endsWith('/embeddings'),
    );
    expect(sent?.authorization).toBe('Bearer private-embedding-key');
    expect(sent?.body.dimensions).toBe(3);
    expect(JSON.stringify(safeMachineServiceTest(test))).not.toContain(
      'private-embedding-key',
    );
  });
  it.each(['bad-dimension', 'zero', 'empty'])(
    'does not accept bad vectors: %s',
    async (model) => {
      const test = await startMachineServiceTest(
        owner,
        input('embedding', { LLM_EMBEDDING_MODEL: model }),
        undefined,
        root,
      );
      expect(test.state).toBe('failed');
    },
  );
  it('uses the native DashScope embedding endpoint with the selected origin and explicit dimension', async () => {
    const test = await startMachineServiceTest(
      owner,
      input('embedding', { LLM_EMBEDDING_API_FORMAT: 'dashscope' }),
      undefined,
      root,
    );
    expect(test.state).toBe('passed');
    const sent = fixture.observed.findLast((request) =>
      request.path.includes('/text-embedding/'),
    );
    expect(sent?.path).toBe(
      '/api/v1/services/embeddings/text-embedding/text-embedding',
    );
    expect(sent?.body.parameters.dimension).toBe(3);
  });
  it('synthesizes, retrieves an owner-only audio artifact and transcribes explicit uploaded bytes', async () => {
    const speech = await startMachineServiceTest(
      owner,
      input('speech'),
      undefined,
      root,
    );
    expect(speech.state).toBe('passed');
    const media = await readMachineTestMedia(speech.id, owner, root);
    expect(media.mimeType).toBe('audio/wav');
    expect(media.bytes.length).toBeGreaterThan(44);
    await expect(
      readMachineTestMedia(speech.id, 'foreign', root),
    ).rejects.toThrow('machine_test_not_found');
    const test = await startMachineServiceTest(
      owner,
      {
        ...input('transcription'),
        audioBase64: fixtureWav().toString('base64'),
      },
      undefined,
      root,
    );
    expect(test).toMatchObject({
      state: 'passed',
      text: '你好，这是知遇的语音测试。',
    });
    const request = fixture.observed.findLast((request) =>
      request.path.endsWith('/generation'),
    );
    expect(request?.body.input.messages[0].content[0].audio).toMatch(
      /^data:audio\/wav;base64,/,
    );
  });
  it('keeps OpenAI audio on its actual OpenAI endpoints', async () => {
    const changes = {
      AUDIO_PROVIDER: 'openai',
      AUDIO_API_KEY: 'new-openai-key',
      AUDIO_TTS_MODEL: 'tts-1',
      AUDIO_TTS_VOICE: 'alloy',
      AUDIO_ASR_MODEL: 'whisper-1',
    };
    const speech = await startMachineServiceTest(
      owner,
      input('speech', changes),
      undefined,
      root,
    );
    expect(speech.state).toBe('passed');
    expect(
      fixture.observed.findLast((request) =>
        request.path.endsWith('/audio/speech'),
      )?.authorization,
    ).toBe('Bearer new-openai-key');
    const text = await startMachineServiceTest(
      owner,
      {
        ...input('transcription', changes),
        audioBase64: fixtureWav().toString('base64'),
      },
      undefined,
      root,
    );
    expect(text.state).toBe('passed');
    expect(fixture.observed.at(-1)?.path).toBe('/api/v1/audio/transcriptions');
  });
  it.each(['unfinished', 'unsafe-media'])(
    'withholds unconfirmed or unsafe synthesis: %s',
    async (model) => {
      const test = await startMachineServiceTest(
        owner,
        input('speech', { AUDIO_TTS_MODEL: model }),
        undefined,
        root,
      );
      expect(test.state).toBe('failed');
      expect(test.mediaHash).toBeUndefined();
    },
  );
  it('preserves an immutable video connection and resumes polling without re-submitting', async () => {
    const request = input('video'),
      before = fixture.submissions;
    const pending = await startMachineServiceTest(
      owner,
      request,
      undefined,
      root,
    );
    expect(pending).toMatchObject({
      state: 'pending',
      providerStatus: 'PENDING',
    });
    expect(pending.taskId).toBeTruthy();
    expect(
      (await startMachineServiceTest(owner, request, undefined, root)).taskId,
    ).toBe(pending.taskId);
    expect(fixture.submissions).toBe(before + 1);
    await expect(
      startMachineServiceTest(owner, input('video'), undefined, root),
    ).rejects.toThrow('machine_test_already_running');
    await writeFile(
      join(root, '.env'),
      'AI_VIDEO_AGENT_VIDEO_API_KEY=changed-not-used\n',
    );
    const running = await pollMachineServiceTest(
      pending.id,
      owner,
      undefined,
      root,
    );
    expect(running.state).toBe('pending');
    const done = await pollMachineServiceTest(
      pending.id,
      owner,
      undefined,
      root,
    );
    expect(done).toMatchObject({
      state: 'passed',
      providerStatus: 'SUCCEEDED',
      mediaType: 'video/mp4',
    });
    expect(
      (await readMachineTestMedia(done.id, owner, root)).bytes.length,
    ).toBeGreaterThan(64);
    expect(fixture.submissions).toBe(before + 1);
    expect(
      fixture.observed.findLast((request) => request.path.includes('/tasks/'))
        ?.authorization,
    ).toBe('Bearer private-video-key');
    const stored = await readFile(
      join(root, '.runtime/model-config/service-tests', pending.id + '.json'),
      'utf8',
    );
    expect(stored).not.toContain('private-video-key');
  });
  it('does not promote a completed task with invalid video bytes', async () => {
    const pending = await startMachineServiceTest(
      owner,
      input('video', { AI_VIDEO_AGENT_VIDEO_MODEL: 'invalid-video' }),
      undefined,
      root,
    );
    await pollMachineServiceTest(pending.id, owner, undefined, root);
    const done = await pollMachineServiceTest(
      pending.id,
      owner,
      undefined,
      root,
    );
    expect(done.state).toBe('unconfirmed');
    expect(done.mediaHash).toBeUndefined();
  });
  it('keeps provider failures redacted and records a definitive 403 as failed', async () => {
    const test = await startMachineServiceTest(
      owner,
      input('video', { AI_VIDEO_AGENT_VIDEO_MODEL: 'http-error' }),
      undefined,
      root,
    );
    expect(test).toMatchObject({ state: 'failed', httpStatus: 403 });
    expect(JSON.stringify(test)).not.toContain('fixture-private-provider-body');
  });
  it('rejects stale versions, foreign owners, cross-group updates and reusing an id for changed input before provider dispatch', async () => {
    const before = fixture.observed.length;
    await expect(
      startMachineServiceTest(
        owner,
        { ...input('speech'), expectedRevision: '0'.repeat(64) },
        undefined,
        root,
      ),
    ).rejects.toThrow('configuration_conflict');
    await expect(
      startMachineServiceTest(
        owner,
        input('speech', { AI_VIDEO_AGENT_VIDEO_MODEL: 'forged' }),
        undefined,
        root,
      ),
    ).rejects.toThrow('machine_field_denied');
    expect(fixture.observed.length).toBe(before);
    const request = input('speech');
    const record = await startMachineServiceTest(
      owner,
      request,
      undefined,
      root,
    );
    await expect(
      pollMachineServiceTest(record.id, 'foreign', undefined, root),
    ).rejects.toThrow('machine_test_not_found');
    await expect(
      startMachineServiceTest(
        owner,
        { ...request, updates: { AUDIO_TTS_VOICE: 'other' } },
        undefined,
        root,
      ),
    ).rejects.toThrow('machine_test_request_conflict');
  });
  it('requires a replacement key on provider/address changes, including a key from an overriding file', async () => {
    await expect(
      startMachineServiceTest(
        owner,
        input('speech', { AUDIO_PROVIDER: 'openai' }),
        undefined,
        root,
      ),
    ).rejects.toThrow('host_change_requires_key');
    await writeFile(
      join(root, '.env.local'),
      'AI_VIDEO_AGENT_WAN_API_KEY=hidden-alias-key',
    );
    await writeFile(
      join(root, '.env'),
      `AI_VIDEO_AGENT_VIDEO_BASE_URL=${fixture.baseUrl}/api/v1\n`,
    );
    revision = (await readMachineModelSettings(true, root)).revision;
    await expect(
      startMachineServiceTest(
        owner,
        input('video', {
          AI_VIDEO_AGENT_VIDEO_BASE_URL: 'https://untrusted.invalid/api/v1',
        }),
        undefined,
        root,
      ),
    ).rejects.toThrow('host_change_requires_key');
  });
  it('aborts before dispatch and does not show success for an empty transcription', async () => {
    const before = fixture.observed.length;
    const aborted = await startMachineServiceTest(
      owner,
      input('speech'),
      AbortSignal.abort(),
      root,
    );
    expect(aborted.state).toBe('failed');
    expect(fixture.observed.length).toBe(before);
    const empty = await startMachineServiceTest(
      owner,
      {
        ...input('transcription', { AUDIO_ASR_MODEL: 'empty' }),
        audioBase64: fixtureWav().toString('base64'),
      },
      undefined,
      root,
    );
    expect(empty.state).toBe('failed');
  });
  it('keeps the runtime test separate from edits and exposes only current-owner history', async () => {
    await expect(
      machineTestEnvironment(
        { ...input('speech', { AUDIO_TTS_MODEL: 'draft' }), source: 'runtime' },
        root,
      ),
    ).rejects.toThrow('runtime_test_has_draft');
    await startMachineServiceTest(owner, input('embedding'), undefined, root);
    expect(await listMachineServiceTests('foreign', root)).toEqual([]);
    expect(await listMachineServiceTests(owner, root)).toHaveLength(1);
  });
});
