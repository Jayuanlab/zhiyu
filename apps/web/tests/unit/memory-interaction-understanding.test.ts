import { describe, expect, it } from 'vitest';
import type { InteractionEvent } from '@/lib/db/schema';
import { createInteractionSourceFilter, extractInteractionJson, interactionAnalysisSchema, interactionCandidatePlanSchema } from '@/lib/memory/understanding/interaction-candidates';
import { buildInteractionAnalysisPrompt, buildInteractionCandidatePrompt } from '@/lib/memory/understanding/interaction-prompts';

function event(content = 'Please   verify\n the current delivery.'): InteractionEvent {
  const now = new Date('2026-10-20T00:00:00Z');
  return { id: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222',
    platform: 'wechat', source: 'wechat_local', conversationId: 'conversation-a', conversationName: 'Fixture conversation',
    conversationType: 'group', senderId: null, senderName: 'Source author', senderDisplayName: null, direction: 'inbound',
    contentType: 'text', content, contentPreview: content, messageTime: now, collectedAt: now, sourceMessageId: 'message-a',
    sourceSequence: null, sourceRaw: {}, dedupeKey: 'message-a', processedStatus: 'new', importance: 'unknown',
    requiresReply: null, createdAt: now, updatedAt: now };
}

describe('Interaction candidate understanding', () => {
  it('normalizes model output into candidates without allowing it to approve or alter source authority', () => {
    const plan = interactionCandidatePlanSchema.parse({ tasks: [{ title: 'Review delivery', sourceEventIds: ['event-a'],
      status: 'done', ownerId: 'forged-owner', revision: 999, confidence: '81' }],
      memories: [{ subject: 'Project', content: 'A proposed understanding', sourceEventIds: ['event-a'], status: 'verified' }] });
    expect(plan.tasks[0]).toMatchObject({ confidence: 81, atomType: 'todo', privacyClass: 'normal', riskLevel: 'low' });
    expect(plan.tasks[0]).not.toHaveProperty('status'); expect(plan.tasks[0]).not.toHaveProperty('ownerId');
    expect(plan.tasks[0]).not.toHaveProperty('revision'); expect(plan.memories[0]).not.toHaveProperty('status');
    expect(plan.notes).toEqual([]);
  });

  it('rejects structurally invalid candidates rather than manufacturing source references or confidence', () => {
    for (const task of [{ title: 'Missing source', sourceEventIds: [] },
      { title: 'Invalid confidence', sourceEventIds: ['event-a'], confidence: 101 },
      { title: 'Invalid atom type', sourceEventIds: ['event-a'], atomType: 'executed' }]) {
      expect(() => interactionCandidatePlanSchema.parse({ tasks: [task] })).toThrow();
    }
  });

  it('repairs fenced model JSON through the same parser used by the host', () => {
    const parsed = extractInteractionJson('```json\n{notes: [], tasks: [], memories: [],}\n```');
    expect(interactionCandidatePlanSchema.parse(parsed)).toEqual({ notes: [], tasks: [], memories: [] });
    expect(() => extractInteractionJson('')).toThrow('Interaction processor did not return JSON');
  });

  it('separates analysis claims from candidate approval and retains explicit evidence requirements', () => {
    const analysis = interactionAnalysisSchema.parse({ summary: 'Source conversation', facts: [{ claim: 'A statement', sourceEventIds: ['event-a'], evidenceStrength: 'medium' }] });
    expect(analysis).toMatchObject({ topics: [], risks: [], contradictions: [], facts: [{ sourceEventIds: ['event-a'] }] });
    expect(() => interactionAnalysisSchema.parse({ summary: 'Source conversation', facts: [{ claim: 'No provenance', sourceEventIds: [], evidenceStrength: 'high' }] })).toThrow();
  });

  it('restricts evidence to exact authorized IDs while preserving first-seen order and one root per ID', () => {
    const filter = createInteractionSourceFilter(['event-a', 'event-b']);
    expect(filter(['foreign', 'event-b', 'event-a', 'event-b', ' event-a '])).toEqual(['event-b', 'event-a']);
    expect(filter(['foreign'])).toEqual([]);
  });

  it('assembles the real prompts from source identities and timestamps without adding missing context', () => {
    const input = event();
    const analysis = interactionAnalysisSchema.parse({ summary: 'A stage-one estimate' });
    const first = buildInteractionAnalysisPrompt([input]), second = buildInteractionCandidatePrompt([input], analysis);
    for (const prompt of [first, second]) {
      expect(prompt).toContain(`id=${input.id}`); expect(prompt).toContain('time=2026-10-20T00:00:00.000Z');
      expect(prompt).toContain('sender=Source author'); expect(prompt).toContain('content=Please verify the current delivery.');
    }
    expect(second).toContain('Stage-one analysis for reference only:');
    expect(second).toContain('A stage-one estimate');
    expect(buildInteractionCandidatePrompt([])).not.toContain(input.id);
  });

  it('retains the established bounded event preview while preserving the evidence identity', () => {
    const input = event('x'.repeat(901));
    const prompt = buildInteractionCandidatePrompt([input]);
    expect(prompt).toContain(`id=${input.id}`);
    expect(prompt).toContain(`content=${'x'.repeat(900)}...`);
    expect(prompt).not.toContain('x'.repeat(901));
  });
});
