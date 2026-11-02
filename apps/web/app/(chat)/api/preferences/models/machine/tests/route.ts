import { z } from 'zod';
import {
  machineServiceOwner,
  machineServiceErrorResponse,
} from '@/lib/ai/machine-service-boundary';
import {
  listMachineServiceTests,
  readMachineTestJson,
  safeMachineServiceTest,
  startMachineServiceTest,
} from '@/lib/ai/machine-service-tests';
export const dynamic = 'force-dynamic';
const schema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['embedding', 'speech', 'transcription', 'video']),
    expectedRevision: z.string().length(64),
    updates: z.record(z.string(), z.string().max(4096).nullable()),
    source: z.enum(['draft', 'runtime']).optional(),
    audioBase64: z
      .string()
      .max(12 * 1024 * 1024)
      .optional(),
  })
  .strict();
export async function GET(request: Request) {
  const owner = await machineServiceOwner(request);
  if (owner instanceof Response) return owner;
  try {
    return Response.json(
      {
        tests: (await listMachineServiceTests(owner)).map(
          safeMachineServiceTest,
        ),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return machineServiceErrorResponse(error);
  }
}
export async function POST(request: Request) {
  const owner = await machineServiceOwner(request);
  if (owner instanceof Response) return owner;
  try {
    const input = schema.parse(await readMachineTestJson(request));
    return Response.json(
      safeMachineServiceTest(
        await startMachineServiceTest(owner, input, request.signal),
      ),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return machineServiceErrorResponse(error);
  }
}
