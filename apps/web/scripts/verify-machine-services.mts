/** Real loopback HTTP, synthetic credentials and private fixture files only. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startModelMediaFixture, fixtureWav } from './model-media-fixture.mjs';
import { readMachineModelSettings } from '../lib/ai/machine-model-settings';
import {
  startMachineServiceTest,
  pollMachineServiceTest,
  readMachineTestMedia,
  safeMachineServiceTest,
} from '../lib/ai/machine-service-tests';
process.env.ENCRYPTION_KEY ||= randomBytes(32).toString('base64url');
process.env.NO_PROXY = '127.0.0.1,localhost';
const fixture = await startModelMediaFixture(),
  root = await mkdtemp(resolve('../../.runtime/media-services-protocol-')),
  owner = 'synthetic-protocol-owner';
const checks: string[] = [];
try {
  const content = [
    `LLM_EMBEDDING_BASE_URL=${fixture.baseUrl}/compatible-mode/v1`,
    'OPENAI_EMBEDDINGS_API_KEY=fixture-embedding-key',
    'LLM_EMBEDDING_MODEL=text-embedding-v4',
    'LLM_EMBEDDING_DIMENSIONS=4',
    'LLM_EMBEDDING_API_FORMAT=openai',
    'AUDIO_PROVIDER=bailian',
    `AUDIO_BASE_URL=${fixture.baseUrl}/api/v1`,
    'AUDIO_API_KEY=fixture-audio-key',
    'AUDIO_TTS_MODEL=qwen-audio-3.1-tts-flash',
    'AUDIO_TTS_VOICE=longanhuan_v3.1',
    'AUDIO_ASR_MODEL=qwen3-asr-flash',
    `AI_VIDEO_AGENT_VIDEO_BASE_URL=${fixture.baseUrl}/api/v1`,
    'AI_VIDEO_AGENT_VIDEO_API_KEY=fixture-video-key',
    'AI_VIDEO_AGENT_VIDEO_MODEL=wan2.7-t2v-2026-06-12',
  ].join('\n');
  await writeFile(join(root, '.env'), content, { mode: 0o600 });
  const revision = (await readMachineModelSettings(true, root)).revision;
  const input = (
    kind: 'embedding' | 'speech' | 'transcription' | 'video',
    updates: Record<string, string | null> = {},
  ) => ({ id: randomUUID(), kind, expectedRevision: revision, updates });
  const vector = await startMachineServiceTest(
    owner,
    input('embedding'),
    undefined,
    root,
  );
  assert.equal(vector.state, 'passed', vector.detail);
  assert.equal(vector.dimensions, 4);
  checks.push('real_openai_embedding_bytes_count_dimensions');
  const native = await startMachineServiceTest(
    owner,
    input('embedding', { LLM_EMBEDDING_API_FORMAT: 'dashscope' }),
    undefined,
    root,
  );
  assert.equal(native.state, 'passed', native.detail);
  checks.push('native_dashscope_embedding_origin_and_dimensions');
  const speech = await startMachineServiceTest(
    owner,
    input('speech'),
    undefined,
    root,
  );
  assert.equal(speech.state, 'passed', speech.detail);
  const audio = await readMachineTestMedia(speech.id, owner, root);
  assert.equal(audio.mimeType, 'audio/wav');
  checks.push('native_bailian_tts_download_verified_audio');
  const transcription = await startMachineServiceTest(
    owner,
    { ...input('transcription'), audioBase64: fixtureWav().toString('base64') },
    undefined,
    root,
  );
  assert.equal(transcription.state, 'passed', transcription.detail);
  checks.push('native_bailian_asr_explicit_base64_and_final_text');
  const videoInput = input('video'),
    before = fixture.submissions;
  const video = await startMachineServiceTest(
    owner,
    videoInput,
    undefined,
    root,
  );
  assert.equal(video.state, 'pending', video.detail);
  await startMachineServiceTest(owner, videoInput, undefined, root);
  assert.equal(fixture.submissions, before + 1);
  assert.equal(
    (await pollMachineServiceTest(video.id, owner, undefined, root)).state,
    'pending',
  );
  const completed = await pollMachineServiceTest(
    video.id,
    owner,
    undefined,
    root,
  );
  assert.equal(completed.state, 'passed', completed.detail);
  assert.equal(
    (await readMachineTestMedia(video.id, owner, root)).mimeType,
    'video/mp4',
  );
  checks.push('real_video_submit_once_poll_and_verified_mp4');
  for (const [kind, updates] of [
    ['embedding', { LLM_EMBEDDING_MODEL: 'bad-dimension' }],
    ['speech', { AUDIO_TTS_MODEL: 'unfinished' }],
    ['transcription', { AUDIO_ASR_MODEL: 'empty' }],
  ] as const) {
    const failed = await startMachineServiceTest(
      owner,
      {
        ...input(kind, updates),
        ...(kind === 'transcription'
          ? { audioBase64: fixtureWav().toString('base64') }
          : {}),
      },
      undefined,
      root,
    );
    assert.equal(failed.state, 'failed');
    checks.push(kind + ':false_success_rejected');
  }
  const safe = JSON.stringify(
    [vector, speech, transcription, completed].map(safeMachineServiceTest),
  );
  assert.ok(!safe.includes('fixture-audio-key'));
  assert.ok(!safe.includes('encryptedConfig'));
  assert.equal(await readFile(join(root, '.env'), 'utf8'), content);
  checks.push('credentials_redacted_configuration_unchanged');
  const receipt = {
    passed: true,
    checks,
    externalProvidersCalled: false,
    fixtureRoot: root,
    limits: [
      'Protocol fixtures validate dispatch and lifecycle, not real model quality or cloud account entitlement.',
    ],
  };
  await writeFile(
    '../../.runtime/media-services-protocol-receipt.json',
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await fixture.close();
}
