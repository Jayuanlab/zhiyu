import {auth} from '@/app/(auth)/auth';
import {reviewLegacyExecution} from '@/lib/work-runtime/legacy-execution-review';
import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
import {NextResponse,type NextRequest} from 'next/server';
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string;executionId:string}>}){
  const session=await auth();if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  if(request.headers.has('X-Work-Actor')&&request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'actor_changed'},{status:409});
  const body=await request.json().catch(()=>null);
  if(!body||typeof body!=='object'||Array.isArray(body)||body.expectedVersion!==0)return NextResponse.json({error:'invalid_command',code:'invalid_command'},{status:400});
  const {id,executionId}=await params;
  try{return NextResponse.json(await reviewLegacyExecution({userId:session.user.id,loopId:id,executionId,source:'owner',commandId:body.commandId,
    expectedSnapshotHash:body.expectedSnapshotHash,controllersStopped:body.controllersStopped,outcome:body.outcome,evidence:body.evidence}));}
  catch(error){
    const code=error instanceof WorkCommandConflict?error.code:'review_failed';
    if(!(error instanceof WorkCommandConflict))console.error('[LegacyExecutionReview]',error);
    return NextResponse.json({error:code,code},{status:error instanceof WorkCommandConflict?error.status:500});
  }
}
