import { afterEach, describe, expect, it, vi } from 'vitest';
const execute = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const {EventEmitter}=await import('node:events');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: (...args:unknown[])=>{
    const promise=execute(...args),child=new EventEmitter();
    promise.then(()=>queueMicrotask(()=>child.emit('close')),()=>queueMicrotask(()=>child.emit('close')));
    return Object.assign(promise,{child});
  } }) };
});
import {
  getWechatLocalHealth,
  runWechatLocalJson,
} from '@/lib/wechat-local/client';

afterEach(() => {
  vi.unstubAllEnvs();
  execute.mockReset();
});

describe('wechat local client', () => {
  it('parses JSON stdout from the configured binary', async () => {
    vi.stubEnv('WECHAT_LOCAL_WX_BINARY', 'fixture-wx');
    execute.mockResolvedValue({ stdout: '{"ok":true}', stderr: '' });

    const result = await runWechatLocalJson<{ ok: boolean }>([
      '-e',
      'console.log(JSON.stringify({ ok: true }))',
    ]);

    expect(result).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith('fixture-wx', expect.any(Array), expect.objectContaining({ windowsHide: true }));
  });

  it('reports health from the configured binary without probing data', async () => {
    vi.stubEnv('WECHAT_LOCAL_WX_BINARY', 'fixture-wx');
    execute.mockResolvedValue({ stdout: 'v1.2.3', stderr: '' });

    const health = await getWechatLocalHealth();

    expect(health.ok).toBe(true);
    expect(health.binary).toBe('fixture-wx');
    expect(health.version).toMatch(/^v\d+\./);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('fixture-wx', ['--version'], expect.any(Object));
  });
});
