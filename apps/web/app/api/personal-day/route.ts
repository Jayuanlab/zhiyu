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
    return Response.json(
      await executeDayCommand(
        await dayOwner(request),
        await dayJson(request),
        request.signal,
      ),
      { headers: privateHeaders },
    );
  } catch (error) {
    return dayErrorResponse(error);
  }
}
