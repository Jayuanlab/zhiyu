import {auth} from '@/app/(auth)/auth';
import {NextResponse} from 'next/server';
import {memoryConnectionStatus} from '@/lib/memory-zhiyu/remote';
export const dynamic='force-dynamic';
export async function GET(){
 const session=await auth();if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
 try{return NextResponse.json(await memoryConnectionStatus(session.user.id),{headers:{'cache-control':'no-store'}});}
 catch{return NextResponse.json({mode:'unknown',status:'unavailable',code:'memory_remote_configuration_invalid',automaticFallback:false},{status:503});}
}
