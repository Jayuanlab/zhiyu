import {
  dayOwner,
  dayErrorResponse,
  privateHeaders,
} from '@/lib/personal-day/http';
import { uploadDaySource } from '@/lib/personal-day/documents';
import { readLimited } from '@openzhiyu/ai/audio';
import { DayError } from '@/lib/personal-day/contracts';
export async function POST(request: Request) {
  try {
    const owner = await dayOwner(request),
      bytes = await readLimited(new Response(request.body), 6 * 1024 * 1024),
      form = await new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body: Uint8Array.from(bytes),
      }).formData();
    if (
      [...form.keys()].some(
        (key) => !['file', 'commandId', 'expectedRevision'].includes(key),
      ) ||
      ['file', 'commandId', 'expectedRevision'].some(
        (key) => form.getAll(key).length !== 1,
      )
    )
      throw new DayError('invalid_input');
    const file = form.get('file');
    if (!(file instanceof File)) throw new DayError('source_file_required');
    const result = await uploadDaySource(
      owner,
      {
        commandId: String(form.get('commandId')),
        expectedRevision: Number(form.get('expectedRevision')),
        name: file.name,
      },
      new Uint8Array(await file.arrayBuffer()),
    );
    return Response.json(result, { headers: privateHeaders });
  } catch (error) {
    return dayErrorResponse(error);
  }
}
