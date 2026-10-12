import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionLease } from '@/lib/work-runtime/execution-lease';
import { markExecutionEffect } from '@/lib/work-runtime/execution-lease';
import { appendWorkshopEvent, listWorkshopEvents } from '@/lib/workshops/service';
import type { WorkshopEvent } from '@/lib/db/schema';

export type CuaBackend = 'javascript' | 'python';

type CuaEvent = {
  sequence: number; type: string; level: string; message: string;
  detail?: string; createdAt: string;
};
type CuaScreenshot = { id: string; label: string; url: string; capturedAt: string };
type CuaDetail = {
  run: { id: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; model: string; summary?: { notes: string[] } };
  events: CuaEvent[];
  browser?: { screenshots: CuaScreenshot[]; currentUrl?: string; pageTitle?: string };
};
type Input = {
  backend: CuaBackend;
  prompt: string;
  toolCallId: string;
  workshopId: string;
  runId: string;
  workDir: string;
  lease: ExecutionLease;
  signal?: AbortSignal;
};

const SCENARIO_ID = 'workshop-computer-task';
const MAX_PROMPT = 12_000;
const MAX_RUNTIME_MS = 10 * 60_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function endpoint(backend: CuaBackend): URL {
  const raw = backend === 'javascript'
    ? process.env.CUA_JAVASCRIPT_URL ?? 'http://127.0.0.1:4001'
    : process.env.CUA_PYTHON_URL ?? 'http://127.0.0.1:4041';
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') {
    throw new Error('CUA runner endpoint must be a local HTTP origin');
  }
  return url;
}

async function jsonRequest<T>(base: URL, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, base), {
    ...options,
    headers: { 'x-cua-backend': options.headers ? String((options.headers as Record<string, string>)['x-cua-backend'] ?? '') : '',
      ...(options.body ? { 'content-type': 'application/json' } : {}) },
    signal: options.signal ?? AbortSignal.timeout(15_000),
    cache: 'no-store',
  });
  const data = await response.json().catch(() => null) as T | { error?: string; code?: string } | null;
  const errorData = data && typeof data === 'object' ? data as { error?: string; code?: string } : null;
  if (!response.ok) throw new Error(`CUA HTTP ${response.status}: ${errorData?.error ?? errorData?.code ?? 'unknown error'}`);
  return data as T;
}

async function wait(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error('CUA task cancelled');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('CUA task cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function eventMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function record(input: Input, type: string, title: string, body: string, metadata: Record<string, unknown>) {
  return appendWorkshopEvent({
    workshopId: input.workshopId, runId: input.runId, type, title, body: body.slice(0, 4_000),
    metadata: { receiptAuthority: 'runtime', provider: 'openai-cua-sample-app', backend: input.backend, toolUseId: input.toolCallId, ...metadata },
  });
}

async function stop(base: URL, backend: CuaBackend, cuaRunId: string) {
  await jsonRequest<CuaDetail>(base, `/api/runs/${encodeURIComponent(cuaRunId)}/stop`, {
    method: 'POST', headers: { 'x-cua-backend': backend }, signal: AbortSignal.timeout(30_000),
  });
}

async function saveArtifacts(input: Input, base: URL, detail: CuaDetail) {
  const outputs = join(input.workDir, 'outputs');
  await mkdir(outputs, { recursive: true });
  const replay = await jsonRequest<unknown>(base, `/api/runs/${encodeURIComponent(detail.run.id)}/replay`, {
    headers: { 'x-cua-backend': input.backend },
  });
  const replayPath = join(outputs, `cua-${detail.run.id}-replay.json`);
  const replayBytes = Buffer.from(JSON.stringify(replay, null, 2), 'utf8');
  await writeFile(replayPath, replayBytes);
  const artifacts: Array<Record<string, string>> = [{
    fileName: `cua-${detail.run.id}-replay.json`, path: replayPath,
    sha256: createHash('sha256').update(replayBytes).digest('hex'),
    label: 'CUA 完整回放', kind: 'replay', mimeType: 'application/json',
  }];
  for (const [index, screenshot] of (detail.browser?.screenshots ?? []).entries()) {
    if (index >= 80) break;
    const expected = `/api/runs/${detail.run.id}/artifacts/screenshots/`;
    if (!screenshot.url.startsWith(expected)) continue;
    const response = await fetch(new URL(screenshot.url, base), { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
    if (!response.ok) continue;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) continue;
    const fileName = `cua-${detail.run.id}-${String(index + 1).padStart(3, '0')}.png`;
    const path = join(outputs, fileName);
    await writeFile(path, bytes);
    artifacts.push({ fileName, path, sha256: createHash('sha256').update(bytes).digest('hex'),
      label: screenshot.label || `CUA 截图 ${index + 1}`, kind: 'screenshot', mimeType: 'image/png' });
  }
  await record(input, 'cua_artifacts', '电脑操作回放已保存', `${artifacts.length - 1} 张截图和完整回放已保存。`, {
    cuaRunId: detail.run.id, artifacts,
  });
  return {
    artifactCount: artifacts.length,
    screenshotCount: artifacts.length - 1,
    artifactFiles: artifacts.map(artifact => artifact.fileName),
  };
}

/** Delegates an entire Work task to the unmodified upstream Responses loop. */
export async function runCuaWorkTask(input: Input): Promise<{
  cuaRunId: string;
  status: CuaDetail['run']['status'];
  summary: string;
  artifactCount: number;
  screenshotCount: number;
  artifactFiles: string[];
  artifactsSavedToWork: true;
  currentUrl?: string;
  pageTitle?: string;
}> {
  if (!input.lease || input.lease.runId !== input.runId || input.lease.workshopId !== input.workshopId) {
    throw new Error('CUA requires the current Work execution lease');
  }
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > MAX_PROMPT) throw new Error('CUA prompt must be 1 to 12000 characters');
  const base = endpoint(input.backend);
  const prior = await listWorkshopEvents(input.workshopId, { runId: input.runId, types: ['cua_intent', 'cua_started'], limit: 1001 });
  const sameCall = (prior as WorkshopEvent[]).filter(event => event.runId === input.runId && eventMetadata(event.metadata).toolUseId === input.toolCallId);
  if (sameCall.length) throw new Error('CUA start was already attempted for this tool call; inspect the recorded run before retrying');
  const capabilities = await jsonRequest<{ backendId: string; codeTool: string; apiKeyConfigured?: boolean }>(base, '/api/capabilities', {
    headers: { 'x-cua-backend': input.backend },
  });
  if (capabilities.backendId !== input.backend || capabilities.codeTool !== (input.backend === 'javascript' ? 'exec_js' : 'exec_py')) {
    throw new Error('CUA backend identity mismatch');
  }
  if (!capabilities.apiKeyConfigured) throw new Error('CUA Responses API key is not configured on this runner');
  const active = await jsonRequest<CuaDetail | null>(base, '/api/runs/active', { headers: { 'x-cua-backend': input.backend } });
  if (active) throw new Error(`CUA ${input.backend} backend is busy with run ${active.run.id}`);
  const promptHash = createHash('sha256').update(prompt).digest('hex');
  await record(input, 'cua_intent', '准备执行电脑任务', '已记录 CUA 启动意图。', { promptHash, scenarioId: SCENARIO_ID });
  await markExecutionEffect(input.lease);
  const start = await jsonRequest<{ runId: string; detail: CuaDetail }>(base, '/api/runs', {
    method: 'POST', headers: { 'x-cua-backend': input.backend },
    body: JSON.stringify({ scenarioId: SCENARIO_ID, prompt, browserMode: input.backend === 'python' ? 'headful' : 'headless' }),
    signal: AbortSignal.timeout(20_000),
  });
  const cuaRunId = start.runId;
  await record(input, 'cua_started', '电脑任务已启动', `CUA ${input.backend} 已接收任务。`, { cuaRunId, promptHash });
  let lastSequence = -1;
  const startedAt = Date.now();
  let detail = start.detail;
  try {
    while (true) {
      input.signal?.throwIfAborted();
      detail = await jsonRequest<CuaDetail>(base, `/api/runs/${encodeURIComponent(cuaRunId)}`, {
        headers: { 'x-cua-backend': input.backend }, signal: input.signal,
      });
      for (const event of detail.events.sort((a, b) => a.sequence - b.sequence)) {
        if (event.sequence <= lastSequence) continue;
        await record(input, 'cua_progress', event.message, event.detail ?? event.type, {
          cuaRunId, cuaSequence: event.sequence, cuaType: event.type, level: event.level, occurredAt: event.createdAt,
        });
        lastSequence = event.sequence;
      }
      if (detail.run.status !== 'running') break;
      if (Date.now() - startedAt > MAX_RUNTIME_MS) throw new Error('CUA task exceeded the 10 minute Work budget');
      await wait(1_000, input.signal);
    }
  } catch (error) {
    try { await stop(base, input.backend, cuaRunId); }
    catch (stopError) {
      await record(input, 'cua_stop_failed', '电脑任务停止结果待核对', String(stopError), { cuaRunId });
    }
    throw error;
  }
  const saved = await saveArtifacts(input, base, detail);
  const summary = detail.run.summary?.notes?.join(' ') || `CUA run ${detail.run.status}; check replay to verify the business outcome.`;
  await record(input, 'cua_finished', '电脑任务执行结束', summary, {
    cuaRunId, status: detail.run.status, artifactCount: saved.artifactCount, outcomeVerified: false,
  });
  if (detail.run.status !== 'completed') throw new Error(`CUA run ${detail.run.status}: ${summary}`);
  return {
    cuaRunId, status: detail.run.status, summary,
    ...saved, artifactsSavedToWork: true,
    ...(detail.browser?.currentUrl ? { currentUrl: detail.browser.currentUrl } : {}),
    ...(detail.browser?.pageTitle ? { pageTitle: detail.browser.pageTitle } : {}),
  };
}
