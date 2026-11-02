'use client';
import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@openzhiyu/ui';
import {
  modelRequest,
  json,
  Note,
  errorMessage,
  formatDate,
  selectClass,
  type MachineData,
} from './common';
import type {
  safeMachineServiceTest,
  MachineTestKind,
} from '@/lib/ai/machine-service-tests';
type TestRecord = ReturnType<typeof safeMachineServiceTest>;
const api = '/api/preferences/models/machine/tests';
const names: Record<MachineTestKind, string> = {
  embedding: '向量',
  speech: '语音合成',
  transcription: '语音识别',
  video: '视频生成',
};
const active = (record: TestRecord) =>
  ['running', 'pending', 'unconfirmed'].includes(record.state);
export function machineTestDetail(
  record: Pick<TestRecord, 'detail' | 'httpStatus'>,
) {
  const codes: Record<string, string> = {
    machine_test_running: '正在发送测试请求',
    embedding_vectors_verified: '已返回有效且维度一致的向量',
    speech_audio_verified_listen_to_confirm:
      '已取得音频文件，请试听确认音色与清晰度',
    transcription_text_received_review_accuracy: '已取得识别文本，请核对准确性',
    video_task_submitted: '任务已提交，正在等待生成',
    video_task_pending: '供应商正在排队',
    video_task_running: '供应商正在生成视频',
    video_submission_unconfirmed:
      '视频提交结果未确认，请在供应商控制台核对；系统不会自动重新生成。',
    video_completed_media_verified: '视频已完成，已读取并检查视频文件',
    video_provider_status_unknown: '供应商尚未给出可确认的状态，可继续查询',
    video_provider_task_failed: '供应商任务失败，请核对模型、地域和权限',
    video_provider_task_canceled: '供应商已取消该任务',
    machine_test_aborted_or_timed_out:
      '等待已停止或超时；视频任务可能仍在供应商执行',
    machine_test_process_interrupted:
      '服务在测试期间重启，结果尚未确认，不会自动重发',
    machine_test_provider_failed: '调用失败，请检查服务地址、模型和配置后重试',
    audio_input_invalid: '请选择有效音频文件',
    audio_input_too_large: '音频不能超过 8 MB',
    audio_bytes_invalid: '返回或上传的内容不是有效音频',
    audio_transcription_empty: '服务未返回可用识别文本',
    audio_transcription_unconfirmed: '识别未正常结束',
    audio_response_invalid: '服务返回格式不符合语音协议',
    audio_synthesis_unconfirmed: '语音合成没有正常完成',
    video_response_invalid: '服务返回格式不符合视频协议',
    video_bytes_invalid: '任务返回内容不是可确认的视频文件',
    video_completed_without_media: '供应商标记完成，但没有返回视频地址',
    media_url_untrusted: '供应商返回的媒体地址不受信，已停止下载',
    media_download_http_error: '无法读取生成的媒体文件',
    media_response_too_large: '返回文件超出测试大小限制',
    embedding_response_invalid: '向量条数、维度或数值不正确',
    embedding_response_invalid_dimensions_or_values:
      '返回向量不符合配置的维度或数值要求',
  };
  const http =
    record.httpStatus ??
    Number(record.detail.match(/embedding_provider_http_(\d+)/)?.[1]);
  if (http) return `服务返回 HTTP ${http}，请检查地址、密钥、模型和地域权限。`;
  return codes[record.detail] || record.detail;
}
export function MachineServiceTests({
  group,
  data,
  updates,
  busy,
}: {
  group: string;
  data: MachineData;
  updates: Record<string, string | null>;
  busy: string | null;
}) {
  const kinds: MachineTestKind[] =
    group === 'audio'
      ? ['speech', 'transcription']
      : [group === 'video' ? 'video' : 'embedding'];
  const [records, setRecords] = useState<
      Partial<Record<MachineTestKind, TestRecord>>
    >({}),
    [testedStamp, setTestedStamp] = useState<
      Partial<Record<MachineTestKind, string>>
    >({});
  const [source, setSource] = useState<'draft' | 'runtime'>('draft'),
    [file, setFile] = useState<File | null>(null),
    [pending, setPending] = useState<MachineTestKind | null>(null),
    [message, setMessage] = useState(''),
    [paused, setPaused] = useState(false);
  const controller = useRef<AbortController | null>(null),
    lastRequest = useRef<string | null>(null),
    pollStarted = useRef(Date.now());
  const groupUpdates = Object.fromEntries(
    Object.entries(updates).filter(([key]) =>
      data.fields.some((field) => field.key === key && field.group === group),
    ),
  );
  const stamp = JSON.stringify({
    revision: data.revision,
    source,
    updates: source === 'draft' ? groupUpdates : {},
  });
  const update = (record: TestRecord) =>
    setRecords((previous) => ({ ...previous, [record.kind]: record }));
  useEffect(() => {
    if (!data.editable) return;
    let disposed = false;
    void modelRequest<{ tests: TestRecord[] }>(api)
      .then((result) => {
        if (disposed) return;
        const latest: Partial<Record<MachineTestKind, TestRecord>> = {};
        for (const record of result.tests)
          if (kinds.includes(record.kind) && !latest[record.kind])
            latest[record.kind] = record;
        setRecords(latest);
      })
      .catch(() => {
        if (!disposed)
          setMessage('暂时无法读取测试记录，可重新打开此页后重试。');
      });
    return () => {
      disposed = true;
      controller.current?.abort();
    };
  }, [data.editable, group]);
  const video = records.video;
  useEffect(() => {
    if (!video?.taskId || !active(video) || paused || pending) return;
    let disposed = false;
    const timer = setTimeout(() => {
      if (Date.now() - pollStarted.current > 10 * 60 * 1000) {
        setPaused(true);
        setMessage('已停止自动查询，可继续查询；供应商任务未因此取消。');
        return;
      }
      void modelRequest<TestRecord>(api + '/' + video.id)
        .then((result) => {
          if (!disposed) update(result);
        })
        .catch((error) => {
          if (!disposed) {
            setPaused(true);
            setMessage(errorMessage(error));
          }
        });
    }, 5000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [video?.id, video?.updatedAt, video?.state, paused, pending]);
  async function audioBase64() {
    if (!file) throw Error('请选择用于识别测试的音频文件。');
    if (file.size > 8 * 1024 * 1024) throw Error('音频不能超过 8 MB。');
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(Error('无法读取音频文件。'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });
  }
  async function run(kind: MachineTestKind) {
    if (pending) return;
    setPending(kind);
    setMessage('');
    setPaused(false);
    pollStarted.current = Date.now();
    const id = crypto.randomUUID(),
      requestController = new AbortController();
    controller.current = requestController;
    lastRequest.current = id;
    try {
      const audio = kind === 'transcription' ? await audioBase64() : undefined;
      const result = await modelRequest<TestRecord>(api, {
        ...json({
          id,
          kind,
          expectedRevision: data.revision,
          updates: source === 'draft' ? groupUpdates : {},
          source,
          ...(audio ? { audioBase64: audio } : {}),
        }),
        signal: requestController.signal,
      });
      update(result);
      setTestedStamp((previous) => ({ ...previous, [kind]: stamp }));
    } catch (error) {
      setMessage(
        requestController.signal.aborted
          ? '已停止等待，不会自动重发。可查询已提交的测试。'
          : errorMessage(error),
      );
    } finally {
      setPending(null);
      controller.current = null;
    }
  }
  async function query() {
    const id = video?.id ?? lastRequest.current;
    if (!id) return;
    setMessage('');
    try {
      const record = await modelRequest<TestRecord>(api + '/' + id);
      update(record);
      pollStarted.current = Date.now();
      setPaused(false);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }
  return (
    <div className="mt-6 space-y-4 border-t pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">调用测试</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            测试结果独立保存，包含当时的服务、模型和时间；不修改配置与索引。
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs">
          测试对象
          <select
            aria-label={`${group === 'audio' ? '语音' : group === 'video' ? '视频' : '向量'}测试对象`}
            className={selectClass + ' !w-auto'}
            value={source}
            onChange={(event) =>
              setSource(event.target.value as 'draft' | 'runtime')
            }
            disabled={Boolean(pending)}
          >
            <option value="draft">页面草稿 / 文件配置</option>
            <option value="runtime">当前 Web 运行配置</option>
          </select>
        </label>
      </div>
      {group === 'embedding' && (
        <p className="text-xs text-muted-foreground">
          发送两段固定短文本，检查向量条数、有限数值和维度；本地模型首次使用可能需要下载。
        </p>
      )}
      {group === 'audio' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            合成测试发送固定短句，可试听结果。识别测试会将所选音频发送至该语音服务，最多
            8 MB。
          </p>
          <label className="block text-xs" htmlFor="machine-asr-file">
            识别测试音频
          </label>
          <Input
            id="machine-asr-file"
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm"
            disabled={!data.editable || Boolean(pending)}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </div>
      )}
      {group === 'video' && (
        <Note>
          生成一次 5 秒、720P
          的固定测试短片，会调用视频服务并可能计费。提交后显示真实任务状态，停止查询不会取消供应商任务。
        </Note>
      )}
      <div className="flex flex-wrap gap-2">
        {kinds.map((kind) => (
          <Button
            key={kind}
            variant="outline"
            onClick={() => void run(kind)}
            disabled={
              !data.editable ||
              Boolean(busy) ||
              Boolean(pending) ||
              (kind === 'transcription' && !file) ||
              (kind === 'video' &&
                video !== undefined &&
                Boolean(video.taskId) &&
                active(video) &&
                testedStamp.video === stamp)
            }
          >
            {pending === kind
              ? '正在测试…'
              : kind === 'video'
                ? '生成测试视频（可能计费）'
                : '测试' + names[kind]}
          </Button>
        ))}
        {pending && (
          <Button variant="outline" onClick={() => controller.current?.abort()}>
            停止等待
          </Button>
        )}
        {video?.taskId && active(video) && (
          <>
            <Button variant="outline" onClick={() => void query()}>
              查询 / 继续查询
            </Button>
            {!paused && (
              <Button
                variant="outline"
                onClick={() => {
                  setPaused(true);
                  setMessage('已停止查询，供应商任务可能仍在执行。');
                }}
              >
                停止查询
              </Button>
            )}
          </>
        )}
        {!pending && lastRequest.current && message && (
          <Button variant="outline" onClick={() => void query()}>
            查询已提交测试
          </Button>
        )}
      </div>
      {message && (
        <div role="alert">
          <Note tone="warning">{message}</Note>
        </div>
      )}
      <div className="space-y-3" aria-live="polite">
        {kinds.map((kind) => {
          const record = records[kind];
          if (!record) return null;
          const current = testedStamp[kind] === stamp;
          return (
            <div key={kind} className="space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {names[kind]} ·{' '}
                  {record.state === 'passed'
                    ? '调用通过'
                    : record.state === 'failed'
                      ? '测试失败'
                      : record.state === 'unconfirmed'
                        ? '结果待确认'
                        : '进行中'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDate(record.updatedAt)}
                </span>
              </div>
              <Note
                tone={
                  record.state === 'failed' ||
                  record.state === 'unconfirmed' ||
                  !current
                    ? 'warning'
                    : record.state === 'passed'
                      ? 'success'
                      : 'muted'
                }
              >
                {machineTestDetail(record)}
              </Note>
              <p className="break-all text-xs text-muted-foreground">
                {record.source === 'runtime'
                  ? '测试时的 Web 运行配置'
                  : '测试时的页面 / 文件配置'}{' '}
                · {record.provider} · {record.model}
                <br />
                {record.baseUrl}
              </p>
              {!current && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  历史或已修改配置的测试结果，不代表当前草稿通过。
                </p>
              )}
              {record.source === 'draft' && (
                <p className="text-xs text-muted-foreground">
                  此结果不代表配置已保存或 Web / Worker 已重启加载。
                </p>
              )}
              {record.dimensions && (
                <p className="text-xs">
                  返回 {record.vectorCount} 条向量，每条 {record.dimensions}{' '}
                  维。
                </p>
              )}
              {record.taskId && (
                <p className="break-all text-xs">
                  任务 ID：{record.taskId} ·{' '}
                  {record.providerStatus ?? '状态未知'}
                </p>
              )}
              {record.kind !== 'video' && active(record) && (
                <Button
                  variant="outline"
                  onClick={() => {
                    void modelRequest<TestRecord>(api + '/' + record.id)
                      .then(update)
                      .catch((error) => setMessage(errorMessage(error)));
                  }}
                >
                  查询测试状态
                </Button>
              )}
              {record.text && (
                <p className="whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-sm">
                  {record.text}
                </p>
              )}
              {record.mediaUrl && record.kind === 'speech' && (
                <audio
                  controls
                  preload="none"
                  src={record.mediaUrl}
                  className="w-full"
                />
              )}
              {record.mediaUrl && record.kind === 'video' && (
                <video
                  controls
                  preload="metadata"
                  src={record.mediaUrl}
                  className="max-h-80 w-full rounded"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
