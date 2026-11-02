import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_MODEL_CENTER_DOCUMENT,
  validateModelCenterDocument,
  resolveCenterModelConfiguration as resolve,
  resolveCenterConversationConfiguration,
  safeModelCenterSnapshot,
  type ModelCenterSnapshot,
} from '@openzhiyu/shared/model-center';
const snapshot = (): ModelCenterSnapshot => ({
  revision: 3,
  updatedAt: '2026-11-03T00:00:00Z',
  secrets: {
    text: 'text-secret',
    agent: 'agent-secret',
    other: 'other-secret',
  },
  document: {
    ...structuredClone(EMPTY_MODEL_CENTER_DOCUMENT),
    connections: [
      {
        id: 'text',
        name: '文本',
        protocol: 'openai_compatible',
        baseUrl: 'https://text.invalid/v1',
        model: 'text-model',
        enabled: true,
      },
      {
        id: 'agent',
        name: '智能体',
        protocol: 'anthropic_compatible',
        baseUrl: 'https://agent.invalid',
        model: 'agent-model',
        enabled: true,
      },
      {
        id: 'other',
        name: '规划',
        protocol: 'openai_compatible',
        baseUrl: 'https://other.invalid/v1',
        model: 'other-model',
        enabled: true,
      },
    ],
    defaults: { openai_compatible: 'text', anthropic_compatible: 'agent' },
  },
});
describe('model center runtime boundaries', () => {
  it('a disabled agent purpose denies an explicitly assigned child tier', () => {
    const s = snapshot();
    s.document.assignments.agent = { mode: 'disabled' };
    s.document.assignments['agent:cheap'] = {
      mode: 'connection',
      connectionId: 'agent',
    };
    expect(() =>
      resolve(s, { purpose: 'agent', tier: 'cheap', env: {} }),
    ).toThrow('model_purpose_disabled');
  });
  it('binds a purpose to a whole connection before deployment overrides', () => {
    const s = snapshot();
    s.document.assignments.workshop_planner = {
      mode: 'connection',
      connectionId: 'other',
      model: 'planner',
    };
    expect(
      resolve(s, {
        purpose: 'workshop_planner',
        env: { WORKSHOP_PLANNER_LLM_BASE_URL: 'https://unused.invalid' },
      }),
    ).toMatchObject({
      model: 'planner',
      apiKey: 'other-secret',
      baseUrl: 'https://other.invalid/v1',
      revision: 'center:3',
    });
  });
  it('inherits the default by protocol without exposing keys', () => {
    const s = snapshot();s.document.defaultConnectionId='agent';
    expect(resolve(s, { purpose: 'agent', env: {} })).toMatchObject({
      apiKey: 'agent-secret',
      model: 'agent-model',
      connectionId: 'agent',
    });
    expect(JSON.stringify(safeModelCenterSnapshot(s))).not.toContain('secret');
  });
  it('rejects incompatible protocol assignments', () => {
    const s = snapshot();
    s.document.assignments.image = { mode: 'connection', connectionId: 'agent' };
    expect(() => validateModelCenterDocument(s.document, s.secrets)).toThrow(
      'assignment_protocol_mismatch',
    );
  });
  it('rejects incomplete enabled connections and duplicates', () => {
    const s = snapshot();
    delete s.secrets.text;
    expect(() => validateModelCenterDocument(s.document, s.secrets)).toThrow(
      'connection_incomplete',
    );
    s.document.connections[0].enabled = false;
    s.document.connections.push(s.document.connections[0]);
    expect(() => validateModelCenterDocument(s.document, s.secrets)).toThrow(
      'duplicate_connection',
    );
  });
  it('denies disabled purposes despite deployment credentials', () => {
    const s = snapshot();
    s.document.assignments.text = { mode: 'disabled' };
    expect(() =>
      resolve(s, {
        purpose: 'text',
        env: {
          LLM_API_KEY: 'key',
          LLM_MODEL: 'model',
          LLM_BASE_URL: 'https://default.invalid',
        },
      }),
    ).toThrow('model_purpose_disabled');
  });
  it('does not fall back when a referenced connection is stopped', () => {
    const s = snapshot();
    s.document.connections[0].enabled = false;
    expect(() =>
      resolve(s, {
        purpose: 'text',
        env: {
          LLM_API_KEY: 'key',
          LLM_MODEL: 'model',
          LLM_BASE_URL: 'https://default.invalid',
        },
      }),
    ).toThrow('model_connection_disabled');
  });
  it('does not read an unrelated default for a complete purpose deployment override', () => {
    const s = snapshot();
    s.document.connections[0].enabled = false;
    expect(
      resolve(s, {
        purpose: 'loop_parser',
        env: {
          LOOP_NL_LLM_API_KEY: 'parser',
          LOOP_NL_LLM_MODEL: 'parser',
          LOOP_NL_LLM_BASE_URL: 'https://parser.invalid',
        },
      })?.apiKey,
    ).toBe('parser');
  });
  it('inherits the agent assignment by tier, while a disabled tier wins', () => {
    const s = snapshot();
    s.document.assignments.agent = {
      mode: 'connection',
      connectionId: 'agent',
      model: 'shared-agent',
    };
    expect(
      resolve(s, { purpose: 'agent', tier: 'cheap', env: {} })?.model,
    ).toBe('shared-agent');
    s.document.assignments['agent:cheap'] = { mode: 'disabled' };
    expect(() =>
      resolve(s, { purpose: 'agent', tier: 'cheap', env: {} }),
    ).toThrow('model_purpose_disabled');
  });
  it('permits task-level model selection on the same connection', () => {
    const s = snapshot();
    s.document.assignments.text = { mode: 'connection', connectionId: 'other' };
    expect(
      resolve(s, { purpose: 'text', env: {}, modelOverride: 'chosen' }),
    ).toMatchObject({
      apiKey: 'other-secret',
      model: 'chosen',
      baseUrl: 'https://other.invalid/v1',
    });
  });
  it('uses the Pi agent binding for conversation across protocols', () => {
    const s = snapshot();
    s.document.conversationProtocol = 'openai_compatible';
    s.document.assignments.agent = { mode: 'connection', connectionId: 'other' };
    expect(resolveCenterConversationConfiguration(s, {})).toMatchObject({
      apiKey: 'other-secret',
      model: 'other-model',
    });
    s.document.assignments.agent = { mode: 'disabled' };
    expect(() => resolveCenterConversationConfiguration(s, {})).toThrow(
      'model_purpose_disabled',
    );
  });
  it('rejects unknown purposes, invalid URLs and credentials in addresses', () => {
    const s = snapshot();
    s.document.assignments['agent:unknown'] = { mode: 'inherit' };
    expect(() => validateModelCenterDocument(s.document, s.secrets)).toThrow(
      'unknown_model_purpose',
    );
    delete s.document.assignments['agent:unknown'];
    s.document.connections[0].baseUrl = 'https://user:password@text.invalid';
    expect(() => validateModelCenterDocument(s.document, s.secrets)).toThrow(
      'model_config_invalid_url',
    );
  });
});

const fixture = vi.hoisted(() => ({ connections: [] as any[] }));
vi.mock('../../../../packages/ai/src/agent/runtime/pi-language-model',()=>({createPiLanguageModel:(config:any,fetch:any)=>{const options={baseURL:config.baseUrl,apiKey:config.apiKey,fetch};fixture.connections.push(options);return {model:config.model,options};}}));
vi.mock('@ai-sdk/openai-compatible',()=>({createOpenAICompatible:(options:any)=>{fixture.connections.push(options);return {imageModel:(model:string)=>({model,options})};}}));

import {
  setAIUserContext,
  clearAIUserContext,
  getModelProvider,
} from '../../../../packages/ai/src/agent/model/providers';
afterEach(() => {
  clearAIUserContext();
  fixture.connections = [];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('generic model adapter consistency', () => {
  it('uses distinct text, vision and image connection tuples', () => {
    const s = snapshot();
    s.document.assignments.text = { mode: 'connection', connectionId: 'text' };
    s.document.assignments.vision = {
      mode: 'connection',
      connectionId: 'other',
      model: 'vision',
    };
    s.document.assignments.image = {
      mode: 'connection',
      connectionId: 'other',
      model: 'image',
    };
    setAIUserContext({
      id: 'owner',
      email: null,
      name: null,
      type: 'regular',
      modelCenterSnapshot: s,
      token: 'private-login-token',
    });
    const p = getModelProvider(false);
    p.languageModel('chat-model');
    p.languageModel('vlm-model');
    p.imageModel!('small-model');
    expect(fixture.connections.map((c) => [c.baseURL, c.apiKey])).toEqual([
      ['https://text.invalid/v1', 'text-secret'],
      ['https://other.invalid/v1', 'other-secret'],
      ['https://other.invalid/v1', 'other-secret'],
    ]);
  });
  it('does not send app JWTs to an external provider', async () => {
    const s = snapshot();
    setAIUserContext({
      id: 'owner',
      email: null,
      name: null,
      type: 'regular',
      modelCenterSnapshot: s,
      token: 'private-login-token',
    });
    getModelProvider(false).languageModel('chat-model');
    const fetch = vi.fn(async (_url: any, _init: any) => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await fixture.connections[0].fetch(
      'https://text.invalid/v1/chat/completions',
      { headers: { Authorization: 'Bearer text-secret' } },
    );
    expect(
      new Headers(fetch.mock.calls[0][1]?.headers).get('Authorization'),
    ).toBe('Bearer text-secret');
  });
  it('defers denied vision/image until that purpose is actually requested', () => {
    const s = snapshot();
    s.document.assignments.vision = { mode: 'disabled' };
    s.document.assignments.image = { mode: 'disabled' };
    setAIUserContext({
      id: 'owner',
      email: null,
      name: null,
      type: 'regular',
      modelCenterSnapshot: s,
    });
    const p = getModelProvider(false);
    expect(() => p.languageModel('chat-model')).not.toThrow();
    expect(() => p.languageModel('vlm-model')).toThrow(
      'model_purpose_disabled',
    );
    expect(() => p.imageModel!('small-model')).toThrow(
      'model_purpose_disabled',
    );
  });
});
