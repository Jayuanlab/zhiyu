/** Run only against the isolated fixture app on 3516. Never alter the live owner. */
import assert from 'node:assert/strict';
import { startModelProviderFixture } from './model-provider-fixture.mjs';
const app = process.env.MODEL_TEST_APP_URL;
if (app !== 'http://127.0.0.1:3516' || !process.env.MODEL_FIXTURE_OWNER)
  throw Error('isolated_fixture_app_required');
const session = await (await fetch(`${app}/api/auth/session`)).json();
assert.equal(session.user.id, process.env.MODEL_FIXTURE_OWNER);
async function api(
  path = '',
  body?: unknown,
  method = body ? 'POST' : 'GET',
  expected = 200,
) {
  const response = await fetch(`${app}/api/preferences/models${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: app! },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return data;
}
const fixture = await startModelProviderFixture(),
  checks: string[] = [];
try {
  assert.equal((await api()).revision, 0);
  let revision = 0;
  const connections = [
    'openai_compatible',
    'openai_responses',
    'anthropic_compatible',
  ].map((protocol, index) => ({
    id: `http_fixture_${index}`,
    name: `Fixture ${protocol}`,
    protocol,
    baseUrl: fixture.baseUrl,
    model: 'text',
    enabled: true,
  }));
  const document = {
    connections,
    defaultConnectionId: connections[0].id,
    defaults: {
      openai_compatible: null,
      openai_responses: null,
      anthropic_compatible: null,
    },
    assignments: {} as Record<string, unknown>,
  };
  for (const connection of connections) {
    document.defaultConnectionId = connection.id;
    const saved = await api(
      '',
      {
        expectedRevision: revision,
        document,
        ...(revision
          ? {}
          : {
              secretUpdates: Object.fromEntries(
                connections.map((c) => [c.id, 'loopback-fixture-key']),
              ),
            }),
      },
      'PUT',
    );
    revision = saved.revision;
    assert.ok(!JSON.stringify(saved).includes('loopback-fixture-key'));
    for (const purpose of [
      'text',
      'agent',
      'conversation',
      'recall_planner',
      'interaction_processor',
      'workshop_planner',
      'loop_parser',
      'loop_checker',
      'report_evaluator',
    ]) {
      assert.equal(saved.effective[purpose].configured, true, purpose);
      assert.equal(
        saved.effective[purpose].connectionId,
        connection.id,
        purpose,
      );
    }
    for (const tier of Object.values(saved.effective.agent_tiers) as any[])
      assert.equal(tier.connectionId, connection.id);
    const tested = await api('/test', {
      revision,
      connectionId: connection.id,
    });
    assert.equal(tested.passed, true);
    assert.equal(tested.persisted, true);
    assert.equal((await api()).tests[0].revision, revision);
    checks.push(
      `${connection.protocol}:atomic_save_shared_resolution_revision_bound_test`,
    );
    for (const stream of [false, true]) {
      const response = await fetch(`${app}/api/ai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: app },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Reply fixture-ok.' }],
          stream,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.ok(text.includes('fixture-ok'), text);
      assert.equal(
        response.headers.get('X-Zhiyu-Model-Revision'),
        saved.effective.text.revision,
      );
      if (stream)
        assert.ok(
          text.includes('[DONE]') && !text.includes('provider_error'),
          text,
        );
    }
    const agent = await fetch(`${app}/api/native/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: app },
      body: JSON.stringify({
        provider: 'pi',
        prompt: 'Reply fixture-ok.',
        allowedTools: [],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const agentText = await agent.text();
    assert.equal(agent.status, 200, agentText);
    const events = agentText
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice(6)));
    assert.ok(
      events.some(
        (event) => event.type === 'result' && event.content === 'fixture-ok',
      ),
      agentText,
    );
    assert.ok(!events.some((event) => event.type === 'error'), agentText);
    checks.push(
      `${connection.protocol}:production_proxy_generate_stream_and_native_pi_agent`,
    );
  }
  await api('', { expectedRevision: 0, document }, 'PUT', 409);
  checks.push('stale_writer_rejected');
  document.assignments.agent = { mode: 'disabled' };
  const denied = await api('', { expectedRevision: revision, document }, 'PUT');
  revision = denied.revision;
  assert.equal(denied.effective.agent.error, 'model_purpose_disabled');
  assert.equal(denied.effective.conversation.configured, false);
  for (const tier of Object.values(denied.effective.agent_tiers) as any[])
    assert.equal(tier.configured, false);
  checks.push('parent_denial_blocks_chat_and_all_tiers');
  const historical = await api('/history?revision=3');
  assert.equal(historical.connections[0].hasApiKey, true);
  assert.ok(!JSON.stringify(historical).includes('loopback-fixture-key'));
  const restored = await api('/rollback', {
    expectedRevision: revision,
    restoreRevision: 3,
  });
  assert.equal(restored.revision, revision + 1);
  assert.equal(restored.history[0].restoredFrom, 3);
  assert.equal(restored.effective.conversation.configured, true);
  checks.push('history_redacted_rollback_creates_new_version');
  const legacy = await fetch(`${app}/api/preferences/ai`, {
    method: 'PUT',
    headers: { Origin: app, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(legacy.status, 409);
  checks.push('legacy_write_redirects_to_one_authority');
  const crossOrigin = await fetch(`${app}/api/preferences/models`, {
    method: 'PUT',
    headers: {
      Origin: 'https://untrusted.invalid',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(crossOrigin.status, 403);
  checks.push('cross_origin_mutation_denied');
  const machine = await api('/machine');
  const invalid = await api(
    '/machine',
    {
      expectedRevision: machine.revision,
      updates: { AUTH_MODE: 'authenticated' },
    },
    'PUT',
    400,
  );
  assert.equal(invalid.error, 'machine_field_denied');
  checks.push('machine_whitelist_enforced_without_file_changes');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await fixture.close();
}
