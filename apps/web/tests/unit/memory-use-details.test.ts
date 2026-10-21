import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryUseDetails } from '@/components/memory-use-details';

describe('memory use details', () => {
  it('shows project applicability and commitment meaning without implying fulfillment', () => {
    const html = renderToStaticMarkup(createElement(MemoryUseDetails, {
      applicability: { status: 'scoped', scenarioKeys: ['project:alpha'] }, useSemantics: { kind: 'commitment' }, status: 'verified',
    }));
    expect(html).toContain('指定场景适用');
    expect(html).toContain('project:alpha');
    expect(html).toContain('履约需查任务');
    expect(html).toContain('不证明当前业务状态');
  });
  it('renders old or malformed metadata as unknown rather than inventing global confirmation', () => {
    const html = renderToStaticMarkup(createElement(MemoryUseDetails, {
      applicability: { status: 'something', scenarioKeys: 'project:bad' }, useSemantics: { kind: {} },
    }));
    expect(html).toContain('适用范围待核对');
    expect(html).not.toContain('主人确认的通用');
    expect(html).not.toContain('project:bad');
  });
});
