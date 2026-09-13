import { auth } from '@/app/(auth)/auth';
import { getWorkshop } from '@/lib/workshops/service';
import { listPendingWorkshopReviewItems, getWorkshopReviewItem } from '@/lib/workshops/review-items';
import { resolveWorkReviewItems } from '@/lib/work-runtime/review-commands';
import { WorkCommandConflict } from '@/lib/work-runtime/command-ledger';
import { NextResponse, type NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const workshop = await getWorkshop(session.user.id, id);
    if (!workshop) {
      return NextResponse.json(
        { error: "Workshop not found" },
        { status: 404 },
      );
    }

    const reviewId = _request.nextUrl.searchParams.get('reviewId');
    if (reviewId) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(reviewId)) return NextResponse.json({error:'Invalid reviewId'}, {status:400});
      const target = await getWorkshopReviewItem(id, reviewId);
      return target ? NextResponse.json(target) : NextResponse.json({error:'Review item not found'}, {status:404});
    }
    const items = await listPendingWorkshopReviewItems(id);
    return NextResponse.json({ items });
  } catch (error) {
    console.error("[WorkshopReviewItemsAPI] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load workshop review items",
      },
      { status: 500 },
    );
  }
}


export async function PATCH(request: NextRequest, {params}: {params: Promise<{id: string}>}) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
    const {id} = await params;
    if (!await getWorkshop(session.user.id, id)) return NextResponse.json({error: 'Workshop not found'}, {status: 404});
    const input = await request.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkCommandConflict('invalid_command');
    const {commandId, expectedVersion, ...body} = input;
    if (typeof commandId !== 'string' || !commandId.trim() || commandId.length > 256 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= 2147483647) throw new WorkCommandConflict('invalid_command');
    return NextResponse.json(await resolveWorkReviewItems({userId: session.user.id, workId: id, commandId, expectedVersion, body}));
  } catch (error) {
    if (error instanceof WorkCommandConflict) return NextResponse.json({error: error.code}, {status: error.status});
    console.error('[WorkshopReviewItemsAPI] PATCH failed');
    return NextResponse.json({error: 'Review update could not be confirmed; retry the same command'}, {status: 500});
  }
}
