import {auth} from '@/app/(auth)/auth';
import {PaperCommandError,readPaperRecoveryReview,decidePaperRecoveryReview} from '@/lib/quant/paper-client';
import {NextResponse} from 'next/server';
import {z} from 'zod';

const decisionSchema=z.object({commandId:z.string().trim().min(1).max(200),reviewHash:z.string().regex(/^[0-9a-f]{64}$/),
  decision:z.enum(['approved','rejected']),acknowledgements:z.record(z.string(),z.boolean())}).strict();
type Context={params:Promise<{reviewId:string}>};
function failure(error:unknown){return NextResponse.json({error:error instanceof PaperCommandError?error.code:'paper_review_unavailable',
  commandId:error instanceof PaperCommandError?error.commandId:undefined},{status:error instanceof PaperCommandError?error.status:503});}

export async function GET(_request:Request,context:Context){
  const session=await auth();
  if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  try{return NextResponse.json(await readPaperRecoveryReview(session.user.id,(await context.params).reviewId),{headers:{'Cache-Control':'no-store'}});}
  catch(error){return failure(error);}
}
export async function POST(request:Request,context:Context){
  const session=await auth();
  if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  if(request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'identity_changed'},{status:409});
  const parsed=decisionSchema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return NextResponse.json({error:'invalid_review_decision'},{status:400});
  try{return NextResponse.json(await decidePaperRecoveryReview(session.user.id,(await context.params).reviewId,parsed.data));}
  catch(error){return failure(error);}
}
