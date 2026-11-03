import { dailyView, executeDayCommand } from '@/lib/personal-day/service';
import {
  dayOwner,
  dayErrorResponse,
  dayJson,
  privateHeaders,
} from '@/lib/personal-day/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    return Response.json(await dailyView(await dayOwner(request)), {
      headers: privateHeaders,
    });
  } catch (error) {
    return dayErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    const owner = await dayOwner(request),
      body = await dayJson(request);
    if (body.operation === 'source_extract') {
      const { submitDailyFeedback } = await import(
        '@/lib/personal-day/maintenance'
      );
      const { commandSchema, businessDate } = await import(
        '@/lib/personal-day/contracts'
      );
      const input = commandSchema.parse(body);
      if (input.operation !== 'source_extract') throw Error('invalid_input');
      return Response.json(
        await submitDailyFeedback(owner, {
          id: input.commandId,
          date: businessDate(),
          text: '提取资料原则，供主人审核。',
          sourceId: input.sourceId,
        }),
        { status: 202, headers: privateHeaders },
      );
    }
    const result = await executeDayCommand(owner, body, request.signal);
    let maintenance = null;
    if (
      ['profile_save', 'context_save', 'source_review'].includes(body.operation)
    ) {
      const { queueMaintenanceRefresh } = await import(
        '@/lib/personal-day/maintenance'
      );
      maintenance = await queueMaintenanceRefresh(owner, body.commandId).catch(
        () => ({
          status: 'received',
          warning: 'maintenance_queue_unavailable',
        }),
      );
    }
    return Response.json(
      { ...result, maintenance },
      { headers: privateHeaders },
    );
  } catch (error) {
    return dayErrorResponse(error);
  }
}
