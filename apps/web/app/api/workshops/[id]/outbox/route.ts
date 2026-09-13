import { auth } from '@/app/(auth)/auth';
import {
  createWorkOutboxDraft,
  listWorkOutbox,
} from '@/lib/work-runtime';
import { NextResponse, type NextRequest } from 'next/server';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    return NextResponse.json({
      outbox: await listWorkOutbox({ userId: session.user.id, workId: id }),
    });
  } catch (error) {
    console.error('[WorkshopOutboxAPI] GET error:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to load outbox',
      },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    const body = await request.json();
    const message = String(body.message ?? '').trim();
    if (!message) {
      return NextResponse.json(
        { error: 'message is required' },
        { status: 400 },
      );
    }

    const { outbox, autoSend } = await createWorkOutboxDraft({
      userId: session.user.id,
      workId: id,
      runId: body.runId ?? null,
      loopId: body.loopId ?? null,
      loopRunId: body.loopRunId ?? null,
      channel: body.channel ?? 'wechat_desktop',
      recipientName: body.recipientName ?? null,
      message,
      status: body.status ?? 'draft',
      confidence: Number(body.confidence ?? 50),
      riskLevel: body.riskLevel ?? 'medium',
      sourceEventIds: Array.isArray(body.sourceEventIds)
        ? body.sourceEventIds
        : [],
      boundaryResult: body.boundaryResult ?? {},
      autoSendIfWhitelisted: true,
      source: 'owner',
      reason: 'Outbox draft created from workshop API.',
    });
    return NextResponse.json({ outbox, autoSend }, { status: 201 });
  } catch (error) {
    console.error('[WorkshopOutboxAPI] POST error:', error);
    if(error instanceof ExecutionLeaseError)return NextResponse.json({error:error.message,code:error.code},{status:error.status});
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to create outbox draft',
      },
      { status: 500 },
    );
  }
}
