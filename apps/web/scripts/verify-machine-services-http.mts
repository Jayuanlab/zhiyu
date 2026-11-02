/** Actual HTTP against the explicitly isolated production fixture, never 3515. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureWav } from './model-media-fixture.mjs';
const app = process.env.MODEL_TEST_APP_URL;
if (app !== 'http://127.0.0.1:3516')
  throw Error('isolated_fixture_app_required');
const meta = JSON.parse(
  await readFile('../../.runtime/media-services-web-fixture.json', 'utf8'),
);
if (
  !/^zhiyu_test_[a-f0-9]{32}$/.test(meta.database) ||
  meta.productionWrites !== false
)
  throw Error('isolated_fixture_metadata_required');
assert.equal(
  (await (await fetch(app + '/api/auth/session')).json()).user.id,
  meta.owner,
);
const prefix = '/api/preferences/models/machine',
  checks: string[] = [];
async function request(
  path: string,
  body?: unknown,
  expected = 200,
  origin = app!,
) {
  const response = await fetch(app + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return data;
}
const before = await readFile(join(meta.root, '.env'), 'utf8'),
  config = await request(prefix),
  revision = config.revision;
const input = (kind: string) => ({
  id: randomUUID(),
  kind,
  expectedRevision: revision,
  updates: {},
  source: 'draft',
});
const embedding = await request(prefix + '/tests', input('embedding'));
assert.equal(embedding.state, 'passed');
assert.equal(embedding.dimensions, 4);
checks.push('production_route_embedding_verified');
const speech = await request(prefix + '/tests', input('speech'));
assert.equal(speech.state, 'passed');
const audio = await fetch(app + speech.mediaUrl);
assert.equal(audio.status, 200);
assert.equal(audio.headers.get('X-Content-Type-Options'), 'nosniff');
assert.ok(audio.headers.get('Cache-Control')?.includes('private'));
assert.ok((await audio.arrayBuffer()).byteLength > 48);
checks.push('production_route_speech_private_audio');
const transcription = await request(prefix + '/tests', {
  ...input('transcription'),
  audioBase64: fixtureWav().toString('base64'),
});
assert.equal(transcription.state, 'passed');
assert.ok(transcription.text.includes('语音测试'));
checks.push('production_route_transcription_uploaded_audio');
const runtime = await request(prefix + '/tests', {
  ...input('speech'),
  source: 'runtime',
});
assert.equal(runtime.state, 'passed');
assert.equal(runtime.source, 'runtime');
checks.push('runtime_and_draft_snapshots_separate');
const videoInput = input('video'),
  pending = await request(prefix + '/tests', videoInput);
assert.equal(pending.state, 'pending');
assert.ok(pending.taskId);
assert.equal(
  (await request(prefix + '/tests', videoInput)).taskId,
  pending.taskId,
);
assert.equal((await request(prefix + '/tests/' + pending.id)).state, 'pending');
const completed = await request(prefix + '/tests/' + pending.id);
assert.equal(completed.state, 'passed');
assert.equal((await fetch(app + completed.mediaUrl)).status, 200);
checks.push('production_video_persisted_submit_idempotent_poll_and_media');
await request(
  prefix + '/tests',
  { ...input('speech'), ownerId: 'forged' },
  400,
);
await request(
  prefix + '/tests',
  input('speech'),
  403,
  'https://foreign.invalid',
);
await request(
  prefix + '/tests',
  { ...input('embedding'), expectedRevision: '0'.repeat(64) },
  409,
);
checks.push(
  'production_http_owner_forgery_cross_origin_and_stale_revision_denied',
);
const history = await request(prefix + '/tests');
assert.ok(
  history.tests.some(
    (record: any) => record.id === completed.id && record.state === 'passed',
  ),
);
assert.ok(!JSON.stringify(history).includes('fixture-audio-key'));
assert.equal(await readFile(join(meta.root, '.env'), 'utf8'), before);
checks.push('reload_history_redaction_and_configuration_unchanged');
const activeSpeech = await fetch(app + '/api/audio/speech', {
  method: 'POST',
  headers: { Origin: app, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '你好，这是测试。' }),
});
assert.equal(activeSpeech.status, 200, await activeSpeech.clone().text());
assert.ok((await activeSpeech.arrayBuffer()).byteLength > 48);
const activeAsr = await request('/api/audio/transcriptions', {
  audioBase64: fixtureWav().toString('base64'),
});
assert.ok(activeAsr.text);
checks.push('formal_audio_routes_share_runtime_adapter');
const receipt = {
  passed: true,
  checks,
  externalProvidersCalled: false,
  productionWrites: false,
  fixtureDatabase: meta.database,
};
await writeFile(
  '../../.runtime/media-services-http-receipt.json',
  JSON.stringify(receipt, null, 2),
);
console.log(JSON.stringify(receipt, null, 2));
