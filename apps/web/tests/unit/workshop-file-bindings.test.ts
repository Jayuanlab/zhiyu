// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SWRConfig } from 'swr';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WorkshopFileBindings } from '@/components/workshop-file-bindings';
let root: Root, element: HTMLDivElement;
const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(), onSaved = vi.fn(async () => {});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
async function render() { const cache = new Map(); await act(async () => root.render(createElement(SWRConfig, { value: { provider: () => cache, shouldRetryOnError: false, dedupingInterval: 0 } },
  createElement(WorkshopFileBindings, { workshopId: 'work-id', canUpload: true, sources: [{ id: 'source-id', name: 'Selected document', type: 'file', enabled: true }], onSaved })))); }
async function click(label: string) { await act(async () => { const button = [...element.querySelectorAll('button')].find(node => node.textContent === label); expect(button).toBeDefined(); button!.click(); }); }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('fetch', fetcher); fetcher.mockReset(); onSaved.mockClear();
  element = document.createElement('div'); document.body.append(element); root = createRoot(element); });
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });
describe('Work formal file authorization UI', () => {
  it('discloses TTL and scope and retries the identical selected file/command/expiry after an uncertain upload', async () => {
    let attempts = 0;
    fetcher.mockImplementation(async (_url, init) => init?.method === 'POST' ? ++attempts === 1 ? response({ error: 'Upload interrupted' }, 503) : response({ status: 'recorded' }) : response({ bindings: [], hasMore: false }));
    await render(); expect(element.textContent).toContain('不授权磁盘目录'); expect(element.querySelector('[aria-label="文件授权天数"]')).not.toBeNull();
    const input = element.querySelector('input[type="file"]') as HTMLInputElement, file = new File(['# synthetic'], 'selected.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true }); await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await click('上传并授权读取与转换'); expect(element.textContent).toContain('Upload interrupted'); expect(element.textContent).not.toContain('文件快照已保存');
    await click('重试原文件上传'); const bodies = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => init!.body as FormData);
    expect(bodies).toHaveLength(2); expect(bodies[0].get('commandId')).toBe(bodies[1].get('commandId')); expect(bodies[0].get('expiresAt')).toBe(bodies[1].get('expiresAt'));
    expect(bodies[0].get('file')).toEqual(bodies[1].get('file')); expect(element.textContent).toContain('正文尚未由模型读取'); expect(onSaved).toHaveBeenCalledOnce();
  });
  it('revokes only the revision actually read and reuses the original CAS command on retry', async () => {
    let attempts = 0; const binding = { id: 'binding-id', sourceId: 'source-id', revision: 7, state: 'active', permissions: ['read'], expiresAt: '2027-01-01T00:00:00Z' };
    fetcher.mockImplementation(async (_url, init) => init?.method === 'POST' ? ++attempts === 1 ? response({ error: 'Audit unavailable' }, 503) : response({ status: 'recorded' }) : response({ bindings: [binding], hasMore: false }));
    await render(); await click('撤销文件授权'); expect(element.textContent).toContain('Audit unavailable'); await click('重试原授权操作');
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'); expect(posts).toHaveLength(2);
    expect(posts[0][0]).toBe('/api/memory/files/bindings/binding-id/revoke'); expect(JSON.parse(String(posts[0][1]?.body))).toMatchObject({ expectedBindingRevision: 7 });
    expect(posts[0][1]?.body).toBe(posts[1][1]?.body); expect(onSaved).toHaveBeenCalledOnce();
  });
});
