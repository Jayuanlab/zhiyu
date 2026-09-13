import {auth} from '@/app/(auth)/auth';
import {listWorkRunReviews} from '@/lib/work-runtime/run-resolution';
import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
import {NextResponse,type NextRequest} from 'next/server';
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){
  const session=await auth();if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  const {id}=await params;
  try{return NextResponse.json(await listWorkRunReviews({userId:session.user.id,workId:id,cursor:request.nextUrl.searchParams.get('cursor')??undefined}));}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Review list unavailable'},{status:error instanceof WorkCommandConflict?error.status:500});}
}
