import {
  machineServiceOwner,
  machineServiceErrorResponse,
} from '@/lib/ai/machine-service-boundary';
import {
  pollMachineServiceTest,
  safeMachineServiceTest,
} from '@/lib/ai/machine-service-tests';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const owner = await machineServiceOwner(request);
  if (owner instanceof Response) return owner;
  try {
    return Response.json(
      safeMachineServiceTest(
        await pollMachineServiceTest(
          (await context.params).id,
          owner,
          request.signal,
        ),
      ),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return machineServiceErrorResponse(error);
  }
}
