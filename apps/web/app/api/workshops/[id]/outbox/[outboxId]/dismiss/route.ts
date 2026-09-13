import {auth} from '@/app/(auth)/auth';
import {dismissWorkOutbox} from '@/lib/work-runtime/outbox-dismiss';
import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
import {NextResponse,type NextRequest} from 'next/server';
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string;outboxId:string}>}){
  const session=await auth();if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  try{
    const {id,outboxId}=await params;const body=await request.json().catch(()=>null);
    if(typeof body?.expectedUpdatedAt!=='string')return NextResponse.json({error:'invalid_command'},{status:400});
    return NextResponse.json(await dismissWorkOutbox({userId:session.user.id,workId:id,outboxId,expectedUpdatedAt:body.expectedUpdatedAt}));
  }catch(error){
    if(error instanceof WorkCommandConflict)return NextResponse.json({error:error.code},{status:error.status});
    return NextResponse.json({error:'未能结束处理，请刷新后重试'},{status:500});
  }
}
