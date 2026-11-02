import { z } from 'zod';
import { SpeechService, resolveAudioConfiguration } from '@openzhiyu/ai/audio';
import {
  machineServiceOwner,
  machineServiceErrorResponse,
} from '@/lib/ai/machine-service-boundary';
import { readMachineTestJson } from '@/lib/ai/machine-service-tests';
const schema = z
  .object({
    audioBase64: z
      .string()
      .max(12 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export async function POST(request: Request) {
  const owner = await machineServiceOwner(request);
  if (owner instanceof Response) return owner;
  try {
    const input = schema.parse(await readMachineTestJson(request));
    const result = await new SpeechService(
      resolveAudioConfiguration(),
    ).transcribe(Buffer.from(input.audioBase64, 'base64'), request.signal);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return machineServiceErrorResponse(error);
  }
}
