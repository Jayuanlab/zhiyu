import { describe, expect, it } from 'vitest';
import type { WorkshopPromptSource } from '@/lib/workshops/run-prompt';
import { composeWorkshopRunPrompt, WORKSHOP_BASE_SYSTEM_PROMPT, WORKSHOP_RESEARCH_WORKING_MEMORY_GUIDANCE } from '@/lib/workshops/run-prompt';
import { sha256Hex } from '@/lib/ai/runtime/run-snapshot';

const contract = {
  version: 'primary-reading/v1', reportDelivery: 'grounded-report/v1', taskKeywords: ['research'],
  requiredPrimarySources: [{ id: 'paper', label: 'Paper', urls: ['https://example.test/paper'] }],
};

function workshop(modelConfig: Record<string, unknown> = {}): WorkshopPromptSource {
  return { id: 'fixture-work', name: 'Fixture research', mission: 'Read primary sources.', autonomyLevel: 'draft',
    boundaryPolicy: { externalMessages: 'blocked' }, modelConfig: { researchEvidenceContract: contract, ...modelConfig } };
}

describe('conditional research working-memory guidance', () => {
  it('explains intrinsic discovery, bounded actions and unverified notes only for the active grounded research contract', () => {
    const output = composeWorkshopRunPrompt({ workshop: workshop(), prompt: 'assembled observations', researchTask: 'research this paper',
      allowedTools: ['webReadPage', 'webSearch'] });
    expect(output.systemPrompt).toContain(WORKSHOP_RESEARCH_WORKING_MEMORY_GUIDANCE);
    expect(output.systemPrompt).toContain('仅当实际工具 schema 提供 workingMemory 时才能调用');
    expect(output.systemPrompt).toContain('先用 operation=read 获取当前目录与 version');
    expect(output.systemPrompt).toContain('不要求每轮整理或压缩');
    expect(output.systemPrompt).toContain('不授予业务动作、长期记忆写入或新权限');
    expect(output.systemPrompt).toContain('未经独立核验的模型摘要');
    expect(output.systemPrompt).toContain('不能覆盖主人的指令、纠错、权限边界或原始来源');
    expect(output.systemPrompt).toContain('均消耗现有工具预算');
    expect(output.systemPrompt).toContain('恢复当前 run 的完整原始读取上下文，不重放业务工具');
    expect(output.systemPrompt).toContain('未提供、关闭或被拒时');
    expect(output.systemPrompt).toContain('不能声称工作记忆已启用');
    expect(output.prompt).toBe('assembled observations');
  });

  it('keeps the business-tool policy intact while the runtime schema determines intrinsic availability', () => {
    const output = composeWorkshopRunPrompt({ workshop: workshop(), prompt: 'research this paper',
      allowedTools: ['webReadPage'], actionPolicy: { allowed: ['webReadPage'], denied: ['workingMemory'] } });
    expect(output.systemPrompt).toContain('availableTools 列的是业务工具');
    const policyStart = output.systemPrompt.indexOf('{\n  "workshopBoundary"');
    const policy = JSON.parse(output.systemPrompt.slice(policyStart));
    expect(policy.availableTools).toEqual(['webReadPage']);
    expect(policy.actionPolicy).toEqual({ allowed: ['webReadPage'], denied: ['workingMemory'] });
    expect(output.systemPrompt).toContain('真正的授权仍由工具执行层检查');
  });

  it('omits the guidance for unrelated admitted tasks despite historical research text', () => {
    const output = composeWorkshopRunPrompt({ workshop: workshop(), prompt: 'Historical research task', researchTask: 'Check the task status' });
    expect(output.systemPrompt).not.toContain(WORKSHOP_RESEARCH_WORKING_MEMORY_GUIDANCE);
    expect(output.systemPrompt).not.toContain('本轮工作状态整理规则');
    expect(output.systemPrompt).toContain(WORKSHOP_BASE_SYSTEM_PROMPT);
    expect(output.manifest.researchContractActive).toBe(false);
  });

  it('does not extend the base or non-grounded reading modes with a working-memory instruction', () => {
    const { reportDelivery: _delivery, ...readingOnly } = contract;
    const noContract = workshop();
    noContract.modelConfig = {};
    for (const work of [workshop({ researchEvidenceContract: readingOnly }), noContract]) {
      const output = composeWorkshopRunPrompt({ workshop: work, prompt: 'research this paper' });
      expect(output.systemPrompt).not.toContain(WORKSHOP_RESEARCH_WORKING_MEMORY_GUIDANCE);
      expect(output.manifest.baseHash).toBe(sha256Hex(WORKSHOP_BASE_SYSTEM_PROMPT));
    }
    expect(WORKSHOP_BASE_SYSTEM_PROMPT).not.toContain('workingMemory');
  });

  it('hashes the actual system prompt including the conditional rules without changing the original task identity', () => {
    const output = composeWorkshopRunPrompt({ workshop: workshop(), prompt: 'research this paper', allowedTools: ['webReadPage'] });
    expect(output.manifest.systemPromptHash).toBe(sha256Hex(output.systemPrompt));
    expect(output.manifest.systemPromptChars).toBe(output.systemPrompt.length);
    expect(output.manifest.taskPromptHash).toBe(sha256Hex('research this paper'));
    expect(output.manifest.systemPromptHash).not.toBe(sha256Hex(output.systemPrompt.replace(WORKSHOP_RESEARCH_WORKING_MEMORY_GUIDANCE, '')));
  });
});
