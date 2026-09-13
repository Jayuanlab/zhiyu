import { describe, expect, it } from 'vitest';
import { latestWorkshopConclusion } from '@/lib/workshops/conclusion';
import { summarizeWorkshopEventForList } from '@/lib/workshops/event-summary';

const event = (type: string, day: number, metadata = {}, title = type) => ({
  type, title, metadata, createdAt: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`,
});
describe('workshop conclusion evidence', () => {
  it('never interprets command acceptance, creation or progress as a result', () => {
    expect(latestWorkshopConclusion([
      event('work_command_applied', 8), event('workshop_created', 7),
      event('agent_text', 8), event('agent_text', 8, {final:true}, 'Agent partial output'),
    ])).toBeNull();
  });
  it('selects by actual event time, independent of cached or incoming array order', () => {
    const result = event('loop_run_completed', 7);
    expect(latestWorkshopConclusion([result, event('decision', 6), event('work_command_applied', 8), null])).toBe(result);
    expect(latestWorkshopConclusion([event('decision', 6), result])).toBe(result);
  });
  it('requires a final text marker, including after metadata compaction', () => {
    const result = summarizeWorkshopEventForList(event('agent_text', 8, {final:true, trace:'x'.repeat(2000)}));
    expect(latestWorkshopConclusion([result])).toBe(result);
  });
  it('keeps internal quality reports and invalid timestamps out of the main conclusion', () => {
    expect(latestWorkshopConclusion([
      event('decision', 8, {}, '报告质量检查'), event('decision', 8, {}, '配置改进提案'),
      {...event('decision', 8), createdAt:'invalid'},
    ])).toBeNull();
  });
});
