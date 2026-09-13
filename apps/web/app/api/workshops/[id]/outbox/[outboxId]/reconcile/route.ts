import {auth} from '@/app/(auth)/auth';
import {reconcileOutboxAttempt} from '@/lib/work-runtime/outbox-dispatch';
import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
import {NextResponse,type NextRequest} from 'next/server';

export const dynamic='force-dynamic';
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string;outboxId:string}>}){
  const session=await auth();
  if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  if(request.headers.has('X-Work-Actor')&&request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'actor_changed'},{status:409});
  const {id,outboxId}=await params;
  if(![id,outboxId].every(value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)))return NextResponse.json({error:'Invalid target'},{status:400});
  try{
    const attempt=await reconcileOutboxAttempt({userId:session.user.id,workId:id,outboxId});
    return NextResponse.json({ok:true,status:attempt.status,attemptId:attempt.id,updatedAt:attempt.updated_at});
  }catch(error){
    return NextResponse.json({error:error instanceof WorkCommandConflict?error.code:'Failed to query send result'},{status:error instanceof WorkCommandConflict?error.status:500});
  }
}
