import {
  dayOwner,
  dayErrorResponse,
  dayJson,
  privateHeaders,
} from '@/lib/personal-day/http';
import {
  configureDayAutomation,
  dayAutomationStatus,
} from '@/lib/personal-day/automation';
export async function GET(request: Request) {
  try {
    return Response.json(
      { automation: await dayAutomationStatus(await dayOwner(request)) },
      { headers: privateHeaders },
    );
  } catch (error) {
    return dayErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    return Response.json(
      await configureDayAutomation(
        await dayOwner(request),
        await dayJson(request),
      ),
      { headers: privateHeaders },
    );
  } catch (error) {
    return dayErrorResponse(error);
  }
}
