import {
  dayOwner,
  dayJson,
  dayErrorResponse,
  privateHeaders,
} from '@/lib/personal-day/http';
import {
  maintenanceView,
  configureMaintenance,
  submitDailyFeedback,
  retryDailyFeedback,
  requestMaintenanceRefresh,
} from '@/lib/personal-day/maintenance';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    return Response.json(await maintenanceView(await dayOwner(request)), {
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
    const { operation, ...value } = body;
    const result =
      operation === 'configure'
        ? await configureMaintenance(owner, value)
        : operation === 'retry'
          ? await retryDailyFeedback(owner, value)
          : operation === 'refresh'
            ? await requestMaintenanceRefresh(owner, value)
            : operation === 'feedback'
              ? await submitDailyFeedback(owner, value)
              : null;
    if (!result)
      return Response.json(
        { error: 'invalid_input' },
        { status: 400, headers: privateHeaders },
      );
    return Response.json(result, {
      status: operation === 'configure' ? 200 : 202,
      headers: privateHeaders,
    });
  } catch (error) {
    return dayErrorResponse(error);
  }
}
