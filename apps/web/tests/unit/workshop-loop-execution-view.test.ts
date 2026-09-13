import { describe, expect, it } from 'vitest';
import { workshopApiErrorMessage } from '@/lib/workshops/api-error-message';
import { loopExecutionView } from '@/lib/workshops/loop-execution-view';

describe('workshop Loop execution feedback', () => {
  it.each([
    ['queued', '已排队'],
    ['running', '运行中'],
    ['cancel_requested', '停止中'],
    ['needs_review', '待处理'],
  ])(
    'prevents a duplicate action while the latest run is %s',
    (status, label) => {
      expect(
        loopExecutionView({ localPending: false, latestRunStatus: status }),
      ).toEqual({ busy: true, actionLabel: label });
    },
  );

  it('keeps the button busy until the accepted request is visible in refreshed data', () => {
    expect(
      loopExecutionView({ localPending: true, latestRunStatus: 'completed' }),
    ).toEqual({ busy: true, actionLabel: '提交中' });
  });

  it('turns target_busy into an actionable message', () => {
    expect(
      workshopApiErrorMessage(
        { code: 'target_busy', error: 'target_busy' },
        'Request failed: 409',
      ),
    ).toBe('该任务已经排队或正在运行，请在运行记录中查看进度，完成后再试。');
  });
});
