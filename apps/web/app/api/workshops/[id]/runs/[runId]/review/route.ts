import {auth} from '@/app/(auth)/auth';
import {getWorkRunReview,resolveWorkRun} from '@/lib/work-runtime/run-resolution';
import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
import {NextResponse,type NextRequest} from 'next/server';
type Context={params:Promise<{id:string;runId:string}>};
function failure(error:unknown){return NextResponse.json({error:error instanceof Error?error.message:'Run review failed'},{status:error instanceof WorkCommandConflict?error.status:500});}
export async function GET(_request:NextRequest,{params}:Context){
  const session=await auth();if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  const {id,runId}=await params;
  try{return NextResponse.json(await getWorkRunReview({userId:session.user.id,workId:id,runId}));}catch(error){return failure(error);}
}
export async function POST(request:NextRequest,{params}:Context){
  const session=await auth();if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  if(request.headers.has('X-Work-Actor')&&request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'actor_changed'},{status:409});
  const body=await request.json().catch(()=>null),commandId=body?.commandId??request.headers.get('Idempotency-Key');
  if(!body||typeof body!=='object'||Array.isArray(body)||typeof commandId!=='string'||!commandId.trim()||!Number.isSafeInteger(body.expectedVersion))return NextResponse.json({error:'invalid_command'},{status:400});
  const {id,runId}=await params;
  try{return NextResponse.json(await resolveWorkRun({userId:session.user.id,workId:id,runId,commandId,expectedVersion:body.expectedVersion,expectedLeaseToken:body.expectedLeaseToken,outcome:body.outcome,evidence:body.evidence,executorStopped:body.executorStopped,source:'owner'}));}catch(error){return failure(error);}
}
