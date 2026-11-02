import { z } from 'zod';
import { SpeechService, resolveAudioConfiguration } from '@openzhiyu/ai/audio';
import {
  machineServiceOwner,
  machineServiceErrorResponse,
} from '@/lib/ai/machine-service-boundary';
import { readMachineTestJson } from '@/lib/ai/machine-service-tests';
const schema = z.object({ text: z.string().trim().min(1).max(4000) }).strict();
export async function POST(request: Request) {
  const owner = await machineServiceOwner(request);
  if (owner instanceof Response) return owner;
  try {
    const { text } = schema.parse(await readMachineTestJson(request));
    const result = await new SpeechService(
      resolveAudioConfiguration(),
    ).synthesize(text, request.signal);
    return new Response(Uint8Array.from(result.bytes), {
      headers: {
        'Content-Type': result.mimeType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return machineServiceErrorResponse(error);
  }
}
