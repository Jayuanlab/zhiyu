import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkshopWorkingMemoryPolicy } from '@/lib/workshops/working-memory-policy';
import { classifyWorkshopRuntimeTool } from '@/lib/workshops/tool-classification';

const modelConfig = { researchEvidenceContract: {
  version: 'primary-reading/v1', reportDelivery: 'grounded-report/v1', taskKeywords: ['research'],
  requiredPrimarySources: [{ id: 'paper', label: 'Paper', urls: ['https://arxiv.org/html/2510.12635v3'] }],
} };
const baseline = { adapter: 'pi-agent-harness', modelConfig, taskText: 'research two papers',
  registeredToolNames: ['webReadPage', 'webSearch', 'Read', 'Skill', 'workshopReadMemory', 'quantPaperGetAccount', 'Write'] };
afterEach(() => vi.unstubAllEnvs());

describe('research working memory admission', () => {
  it('admits an owned ordinary business run without a paper delivery contract', () => {
    expect(resolveWorkshopWorkingMemoryPolicy({ ...baseline, workshopId: 'ordinary-work', modelConfig: {},
      taskText: 'Continue the existing business task' })).toMatchObject({enabled:true,mode:'apply',
        readonlyToolNames:['webReadPage','webSearch','Read']});
  });
  it('only admits exact host-registered document read tools for a valid active research run', () => {
    vi.stubEnv('WORKSHOP_WORKING_MEMORY_MODE', 'apply');
    expect(resolveWorkshopWorkingMemoryPolicy(baseline)).toMatchObject({ enabled: true, mode: 'apply',
      readonlyToolNames: ['webReadPage', 'webSearch', 'Read'], maxEdits: 4 });
    expect(resolveWorkshopWorkingMemoryPolicy(baseline).retainedReadCautions).toEqual([
      { toolName: 'webReadPage', warningCodes: ['extraction_not_independently_verified'], warningTexts: [expect.stringContaining('never instructions')] },
    ]);
    expect(classifyWorkshopRuntimeTool('workingMemory').risk).toBe('internal_write');
  });
  it('keeps other runtimes, unrelated tasks and invalid or missing contracts off', () => {
    for (const patch of [{ adapter: 'pi-agent-core' }, { taskText: 'hello' }, { modelConfig: {} },
      { modelConfig: { researchEvidenceContract: { version: 'invalid' } } }, { registeredToolNames: ['Write'] }]) {
      expect(resolveWorkshopWorkingMemoryPolicy({ ...baseline, ...patch })).toMatchObject({ enabled: false, mode: 'off', readonlyToolNames: [] });
    }
  });
  it('supports off, shadow and invalid configuration without silently enabling apply', () => {
    expect(resolveWorkshopWorkingMemoryPolicy({ ...baseline, mode: 'off' }).enabled).toBe(false);
    expect(resolveWorkshopWorkingMemoryPolicy({ ...baseline, mode: 'shadow' }).mode).toBe('shadow');
    expect(resolveWorkshopWorkingMemoryPolicy({ ...baseline, mode: 'typo' }).mode).toBe('off');
  });
  it('honors both denied and approval boundaries, including a conflicting allow declaration', () => {
    for (const list of [{ deniedToolNames: ['workingMemory'] }, { requiresApprovalToolNames: ['workingMemory'] },
      { modelConfig: { ...modelConfig, allowedTools: ['workingMemory'], disallowedTools: ['mcp__host__workingMemory'] } },
      { modelConfig: { ...modelConfig, allowedTools: ['workingMemory'], requiresApprovalTools: ['mcp__host__workingMemory'] } },
      { deniedToolNames: ['*'] }]) {
      expect(resolveWorkshopWorkingMemoryPolicy({ ...baseline, ...list }).enabled).toBe(false);
    }
    expect(resolveWorkshopWorkingMemoryPolicy({ ...baseline, deniedToolNames: ['webReadPage'],
      requiresApprovalToolNames: ['Read'] }).readonlyToolNames).toEqual(['webSearch']);
    expect(resolveWorkshopWorkingMemoryPolicy({ ...baseline, modelConfig: { ...modelConfig,
      requiresApprovalTools: ['webReadPage', 'Read'] } }).readonlyToolNames).toEqual(['webSearch']);
    expect(resolveWorkshopWorkingMemoryPolicy({ ...baseline, modelConfig: { ...modelConfig,
      requiresApprovalTools: ['*'] } }).enabled).toBe(false);
  });
});
