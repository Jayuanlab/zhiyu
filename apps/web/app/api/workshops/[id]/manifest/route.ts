import {auth} from '@/app/(auth)/auth';
import {exportWorkshopManifest} from '@/lib/workshops/manifest-export';
import {NextResponse} from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({error: 'Unauthorized'}, {status: 401});
  try {
    const result = await exportWorkshopManifest(session.user.id, (await params).id);
    return result ? NextResponse.json(result, {headers: {'Cache-Control': 'no-store'}}) : NextResponse.json({error: 'Workshop not found'}, {status: 404});
  } catch (error) {
    console.error('[WorkshopManifest] export failed', error);
    return NextResponse.json({error: '无法读取完整配置，请稍后重试'}, {status: 500});
  }
}
