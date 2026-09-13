import {auth} from '@/app/(auth)/auth';
import {cancelWorkRun} from '@/lib/work-runtime/cancel-run';
import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
import {NextResponse,type NextRequest} from 'next/server';

export async function POST(request:NextRequest,{params}:{params:Promise<{id:string;runId:string}>}){
  const session=await auth();
  if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  if(request.headers.has('X-Work-Actor')&&request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'actor_changed'},{status:409});
  const body=await request.json().catch(()=>null);
  if(!body||typeof body!=='object'||Array.isArray(body))return NextResponse.json({error:'invalid_command'},{status:400});
  const commandId=body.commandId??request.headers.get('Idempotency-Key');
  if(typeof commandId!=='string'||!commandId.trim())return NextResponse.json({error:'invalid_command'},{status:400});
  const {id,runId}=await params;
  try{
    return NextResponse.json(await cancelWorkRun({userId:session.user.id,workId:id,runId,commandId,expectedVersion:body.expectedVersion,reason:typeof body.reason==='string'?body.reason:null,source:'owner'}));
  }catch(error){
    return NextResponse.json({error:error instanceof Error?error.message:'Cancellation failed'},{status:error instanceof WorkCommandConflict?error.status:500});
  }
}
