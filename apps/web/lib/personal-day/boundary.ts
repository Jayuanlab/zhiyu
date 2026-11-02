import type { Workshop, Loop } from '@/lib/db/schema';
import {
  getWorkshopBoundaryPolicy,
  workshopBoundaryToLoopPolicies,
} from '@/lib/workshops/boundary-policy';
import { decideLoopActionApproval } from '@/lib/loops/approval';
import { DayError } from './contracts';
/** Host capability gate runs before reading health facts or saving a draft. */
export function assertDailyAutomationBoundary(
  work: Workshop | null,
  loop: Loop,
) {
  const config = work?.modelConfig as any;
  if (
    !work ||
    work.status !== 'active' ||
    config?.role !== 'personal_daily_planner' ||
    !config.allowedTools?.includes('personalDayDraft') ||
    getWorkshopBoundaryPolicy(work).mode === 'observe'
  )
    throw new DayError('automation_boundary_denied', 403);
  const bridge = workshopBoundaryToLoopPolicies({
    workshop: work,
    actionPolicy: loop.actionPolicy,
    approvalPolicy: loop.approvalPolicy,
  });
  const denials = [
    ...(bridge.actionPolicy.denied as string[]),
    ...(config.disallowedTools ?? []),
  ];
  if (
    denials.some((name: string) => {
      const pattern = name.toLowerCase();
      return (
        pattern.endsWith('*') &&
        'personaldaydraft'.startsWith(pattern.slice(0, -1))
      );
    })
  )
    throw new DayError('automation_boundary_denied', 403);
  const decision = decideLoopActionApproval({
    actionName: 'personalDayDraft',
    actionPolicy: {
      ...bridge.actionPolicy,
      denied: [
        ...(bridge.actionPolicy.denied as string[]),
        ...(config.disallowedTools ?? []),
      ],
    },
    approvalPolicy: bridge.approvalPolicy,
  });
  if (
    decision.decision !== 'allow' ||
    !(loop.actionPolicy.allowed as string[] | undefined)?.includes(
      'personalDayDraft',
    )
  )
    throw new DayError('automation_boundary_denied', 403);
}
