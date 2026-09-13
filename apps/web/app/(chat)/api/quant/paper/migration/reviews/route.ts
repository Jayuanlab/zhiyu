import {auth} from '@/app/(auth)/auth';
import {PaperCommandError,preparePaperRecoveryReview} from '@/lib/quant/paper-client';
import {NextResponse} from 'next/server';

export async function POST(request:Request){
  const session=await auth();
  if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  if(request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'identity_changed'},{status:409});
  try{return NextResponse.json(await preparePaperRecoveryReview(session.user.id),{headers:{'Cache-Control':'no-store'}});}
  catch(error){return NextResponse.json({error:error instanceof PaperCommandError?error.code:'paper_review_unavailable'},
    {status:error instanceof PaperCommandError?error.status:503});}
}
