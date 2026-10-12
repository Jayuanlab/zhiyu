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
  getWechatLocalSessions,
} from '@/lib/wechat-local/client';

afterEach(() => {
  vi.unstubAllEnvs();
  execute.mockReset();
});

describe('wechat local client', () => {
  function managedReader() {
    vi.stubEnv('ZHIYU_OPTIONAL_WECHAT_ENABLED', 'true');
    vi.stubEnv('WECHAT_LOCAL_WX_BINARY', process.execPath);
    vi.stubEnv('WECHAT_LOCAL_DATA_DIR', process.cwd());
    vi.stubEnv('WX_CLI_SESSION_TOKEN', 'a'.repeat(40));
  }

  it('never starts a reader before component enablement and completed authorization', async () => {
    managedReader();
    vi.stubEnv('ZHIYU_OPTIONAL_WECHAT_ENABLED', 'false');
    await expect(getWechatLocalSessions({ limit: 1 })).rejects.toThrow('wechat_reader_disabled');
    vi.stubEnv('ZHIYU_OPTIONAL_WECHAT_ENABLED', 'true');
    vi.stubEnv('WECHAT_LOCAL_AUTHORIZED', 'false');
    await expect(getWechatLocalSessions({ limit: 1 })).rejects.toThrow('wechat_reader_init_required');
    expect(execute).not.toHaveBeenCalled();
  });

  it('can inspect a bundled version while disabled without probing any messages', async () => {
    managedReader();
    vi.stubEnv('ZHIYU_OPTIONAL_WECHAT_ENABLED', 'false');
    vi.stubEnv('WECHAT_LOCAL_AUTHORIZED', 'false');
    execute.mockResolvedValue({ stdout: 'wx-cli 0.6.3', stderr: '' });
    const result = await getWechatLocalHealth();
    expect(result).toMatchObject({ ok: true, installed: true, authorized: false, status: 'disabled' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(process.execPath, ['--version'], expect.any(Object));
  });

  it('uses private authenticated storage and excludes model credentials from an authorized child', async () => {
    managedReader();
    vi.stubEnv('WECHAT_LOCAL_AUTHORIZED', 'true');
    vi.stubEnv('LLM_API_KEY', 'fixture-must-not-reach-reader');
    execute.mockResolvedValue({ stdout: '{"sessions":[]}', stderr: '' });
    await getWechatLocalSessions({ limit: 1 });
    const options = execute.mock.calls[0][2];
    expect(options.cwd).toBe(process.cwd());
    expect(options.env.WX_CLI_HOME).toBe(process.cwd());
    expect(options.env.WX_CLI_SESSION_TOKEN).toBe('a'.repeat(40));
    expect(options.env.LLM_API_KEY).toBeUndefined();
    await expect(runWechatLocalJson(['init'])).rejects.toThrow('wechat_reader_command_not_allowed');
    expect(execute).toHaveBeenCalledTimes(1);
  });

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
