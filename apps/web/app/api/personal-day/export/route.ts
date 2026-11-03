import {
  dayOwner,
  dayErrorResponse,
  privateHeaders,
} from '@/lib/personal-day/http';
import {listDailyFeedback} from '@/lib/personal-day/feedback-store';
import { readDaySnapshot } from '@/lib/personal-day/store';
export async function GET(request: Request) {
  try {
    const owner=await dayOwner(request);
    return Response.json(
      {
        schema: 'personal-day-export.v1',
        exportedAt: new Date().toISOString(),
        data: await readDaySnapshot(owner, undefined, true),
        feedback: await listDailyFeedback(owner,undefined,true),
      },
      {
        headers: {
          ...privateHeaders,
          'Content-Disposition':
            'attachment; filename="personal-day-data.json"',
        },
      },
    );
  } catch (error) {
    return dayErrorResponse(error);
  }
}
