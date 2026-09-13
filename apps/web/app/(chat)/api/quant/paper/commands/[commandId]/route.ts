import {auth} from '@/app/(auth)/auth';
import {PaperCommandError,readPaperCommand} from '@/lib/quant/paper-client';
import {NextResponse} from 'next/server';

export async function GET(request:Request,{params}:{params:Promise<{commandId:string}>}){
  const session=await auth();
  if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  try{
    const {commandId}=await params;
    return NextResponse.json(await readPaperCommand({ownerId:session.user.id,actorId:`user:${session.user.id}`,role:'owner'},commandId,new URL(request.url).searchParams.get('accountId')??undefined));
  }catch(error){return NextResponse.json({error:error instanceof PaperCommandError?error.code:'paper_service_unavailable'},{status:error instanceof PaperCommandError?error.status:503});}
}
