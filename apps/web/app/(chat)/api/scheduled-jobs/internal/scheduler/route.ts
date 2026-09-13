import {NextResponse} from 'next/server';
import {auth} from '@/app/(auth)/auth';
import {bootstrapRuntimeForUser} from '@/lib/runtime/bootstrap';
export const dynamic='force-dynamic';

/** Legacy URL remains read-only; lifecycle commands belong to the local process manager. */
export async function GET(_request:Request){
  try{
    const session=await auth();
    if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
    return NextResponse.json(await bootstrapRuntimeForUser({userId:session.user.id}),{headers:{'Cache-Control':'no-store'}});
  }catch{return NextResponse.json({error:'runtime_status_unavailable'},{status:503});}
}
export async function POST(){
  const session=await auth();
  if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  return NextResponse.json({error:'legacy_scheduler_control_retired'},{status:410});
}
