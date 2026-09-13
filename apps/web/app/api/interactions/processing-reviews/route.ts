import {auth} from '@/app/(auth)/auth';
import {getInteractionProcessingReview,listInteractionProcessingReviews,closeInteractionProcessingReview,InteractionReviewConflict} from '@/lib/interactions/processing-reviews';
import {requestBoundary,getAuthMode} from '@/lib/auth/request-boundary';
import {z} from 'zod';
import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const session=await auth();
  if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  const jobId=new URL(request.url).searchParams.get('jobId');
  if(jobId&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(jobId))return NextResponse.json({error:'invalid_job_id'},{status:400});
  try{
    if(jobId){
      const result=await getInteractionProcessingReview(session.user.id,jobId);
      return NextResponse.json(result??{error:'not_found'},{status:result?200:404,headers:{'Cache-Control':'no-store'}});
    }
    const jobs=await listInteractionProcessingReviews(session.user.id,new URL(request.url).searchParams.get('history')==='1');
    return NextResponse.json({jobs:jobs.slice(0,100),truncated:jobs.length>100},{headers:{'Cache-Control':'no-store'}});
  }catch{return NextResponse.json({error:'interaction_review_unavailable'},{status:503});}
}
const decisionSchema=z.object({jobId:z.string().uuid(),attempt:z.number().int().positive(),commandId:z.string().uuid(),acknowledgedUnknown:z.literal(true),decision:z.enum(['keep_results_end','resume_plan']).optional(),planHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict()
  .refine(value=>value.decision!=='resume_plan'||!!value.planHash);
export async function POST(request:Request){
  const session=await auth();
  if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  const boundary=requestBoundary(request,getAuthMode());
  if(boundary)return NextResponse.json({error:boundary},{status:403});
  let body;try{body=decisionSchema.parse(await request.json());}catch{return NextResponse.json({error:'invalid_review_decision'},{status:400});}
  try{return NextResponse.json(await closeInteractionProcessingReview({userId:session.user.id,...body}),{headers:{'Cache-Control':'no-store'}});}
  catch(error){return NextResponse.json({error:error instanceof InteractionReviewConflict?error.message:'review_decision_unconfirmed'},{status:error instanceof InteractionReviewConflict?409:503});}
}
