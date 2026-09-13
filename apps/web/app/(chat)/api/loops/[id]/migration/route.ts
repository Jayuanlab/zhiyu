import {auth} from '@/app/(auth)/auth';
import {previewStandaloneLoopMigration,migrateStandaloneLoopToWork} from '@/lib/work-runtime/loop-migration';
import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
import {NextResponse,type NextRequest} from 'next/server';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
function failure(error:unknown){
  const code=error instanceof WorkCommandConflict?error.code:'migration_failed';
  if(!(error instanceof WorkCommandConflict))console.error('[LoopMigration]',error);
  return NextResponse.json({error:code,code},{status:error instanceof WorkCommandConflict?error.status:500});
}
export async function GET(_request:NextRequest,{params}:Context){
  const session=await auth();if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  try{return NextResponse.json(await previewStandaloneLoopMigration({userId:session.user.id,loopId:(await params).id}));}catch(error){return failure(error);}
}
export async function POST(request:NextRequest,{params}:Context){
  const session=await auth();if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  if(request.headers.has('X-Work-Actor')&&request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'actor_changed'},{status:409});
  const body=await request.json().catch(()=>null),commandId=body?.commandId??request.headers.get('Idempotency-Key');
  if(!body||typeof body!=='object'||Array.isArray(body)||body.expectedVersion!==0)return NextResponse.json({error:'invalid_command',code:'invalid_command'},{status:400});
  try{return NextResponse.json(await migrateStandaloneLoopToWork({userId:session.user.id,loopId:(await params).id,source:'owner',
    commandId,expectedVersion:0,expectedSnapshotHash:body.expectedSnapshotHash,controllersStopped:body.controllersStopped,
    ...(body.nativeReplacement!==undefined?{nativeReplacement:body.nativeReplacement}:{})}));}catch(error){return failure(error);}
}
