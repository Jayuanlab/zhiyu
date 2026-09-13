import {auth} from '@/app/(auth)/auth';
import {getOutboxResolutionState,resolveWorkOutbox} from '@/lib/work-runtime/outbox-resolution';
import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
import {NextResponse,type NextRequest} from 'next/server';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string;outboxId:string}>};
function failure(error:unknown){return NextResponse.json({error:error instanceof WorkCommandConflict?error.code:'核实尚未完成，请查询当前请求后继续；旧消息不会自动重发。'},{status:error instanceof WorkCommandConflict?error.status:503});}
export async function GET(_request:NextRequest,{params}:Context){
  const session=await auth();if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  const {id,outboxId}=await params;
  try{return NextResponse.json(await getOutboxResolutionState({userId:session.user.id,workId:id,outboxId}));}catch(error){return failure(error);}
}
export async function POST(request:NextRequest,{params}:Context){
  const session=await auth();if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  if(request.headers.has('X-Work-Actor')&&request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'actor_changed'},{status:409});
  const {id,outboxId}=await params;
  const body=await request.json().catch(()=>null);
  if(!body||!['attemptId','commandId','expectedContentHash','decision','evidence'].every(key=>typeof body[key]==='string'))return NextResponse.json({error:'Invalid resolution'},{status:400});
  try{return NextResponse.json(await resolveWorkOutbox({userId:session.user.id,workId:id,outboxId,attemptId:body.attemptId,commandId:body.commandId,expectedContentHash:body.expectedContentHash,decision:body.decision,evidence:body.evidence}));}catch(error){return failure(error);}
}
