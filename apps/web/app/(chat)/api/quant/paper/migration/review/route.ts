import { auth } from '@/app/(auth)/auth';
import { PaperCommandError, readPaperImportReview } from '@/lib/quant/paper-client';
import { NextResponse } from 'next/server';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({error:'Unauthorized'}, {status:401});
  try {
    return NextResponse.json(await readPaperImportReview(session.user.id), {headers:{'Cache-Control':'no-store'}});
  } catch (error) {
    return NextResponse.json({error:error instanceof PaperCommandError ? error.code : 'paper_review_unavailable'},
      {status:error instanceof PaperCommandError ? error.status : 503, headers:{'Cache-Control':'no-store'}});
  }
}
