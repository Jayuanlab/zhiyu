import {
  dayOwner,
  dayErrorResponse,
  privateHeaders,
} from '@/lib/personal-day/http';
import { readDaySnapshot } from '@/lib/personal-day/store';
import { DayError } from '@/lib/personal-day/contracts';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = (await params).id,
      snapshot = await readDaySnapshot(await dayOwner(request)),
      source = snapshot.sources.find((s) => s.id === id);
    if (!source) throw new DayError('source_not_found', 404);
    if (
      new URL(request.url).searchParams.has('download') &&
      source.originalBase64
    )
      return new Response(Buffer.from(source.originalBase64, 'base64'), {
        headers: {
          ...privateHeaders,
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="source${source.format}"`,
        },
      });
    const { originalBase64, ...safe } = source;
    return Response.json(safe, { headers: privateHeaders });
  } catch (error) {
    return dayErrorResponse(error);
  }
}
