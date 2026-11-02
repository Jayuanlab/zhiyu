import {
  dayOwner,
  dayErrorResponse,
  privateHeaders,
} from '@/lib/personal-day/http';
import { readDaySnapshot } from '@/lib/personal-day/store';
export async function GET(request: Request) {
  try {
    return Response.json(
      {
        schema: 'personal-day-export.v1',
        exportedAt: new Date().toISOString(),
        data: await readDaySnapshot(await dayOwner(request), undefined, true),
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
