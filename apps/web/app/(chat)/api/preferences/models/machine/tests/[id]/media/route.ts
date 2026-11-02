import {
  machineServiceOwner,
  machineServiceErrorResponse,
} from '@/lib/ai/machine-service-boundary';
import { readMachineTestMedia } from '@/lib/ai/machine-service-tests';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const owner = await machineServiceOwner(request);
  if (owner instanceof Response) return owner;
  try {
    const media = await readMachineTestMedia((await context.params).id, owner);
    return new Response(new Uint8Array(media.bytes), {
      headers: {
        'Content-Type': media.mimeType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': String(media.bytes.byteLength),
      },
    });
  } catch (error) {
    return machineServiceErrorResponse(error);
  }
}
