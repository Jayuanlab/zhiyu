import {resolveLoopApprovalCommand} from "@/lib/loops/approval-command";
import {WorkCommandConflict} from "@/lib/work-runtime/command-ledger";
import { auth } from "@/app/(auth)/auth";
import {
	buildLoopApprovalContinuation,
} from "@/lib/loops/approval-continuation";
import {
	buildLoopApprovalReplayConfirmationToken,
	sanitizeReplayToolInput,
} from "@/lib/loops/approval-replay";
import { getApprovalRequestContinuation } from "@/lib/loops/approval-resume";
import {
	getLoopApprovalRequest,
} from "@/lib/loops/service";
import type { LoopApprovalRequestStatus } from "@/lib/loops/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type ResolvableLoopApprovalRequestStatus = Exclude<
	LoopApprovalRequestStatus,
	"pending"
>;

const RESOLVABLE_STATUSES = new Set<ResolvableLoopApprovalRequestStatus>([
	"approved",
	"rejected",
	"superseded",
]);

function isResolvableStatus(
	status: LoopApprovalRequestStatus | undefined,
): status is ResolvableLoopApprovalRequestStatus {
	return Boolean(status && RESOLVABLE_STATUSES.has(status as never));
}

function replayConfirmationRequired(capability: string | null): boolean {
	return capability === "write_external" || capability === "dangerous";
}

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await auth();
		if (!session?.user?.id) {
			return new Response("Unauthorized", { status: 401 });
		}

		const { id } = await params;
		const approvalRequest = await getLoopApprovalRequest(session.user.id, id);
		if (!approvalRequest) {
			return NextResponse.json(
				{ error: "Approval request not found" },
				{ status: 404 },
			);
		}

		const continuationPreview =
			getApprovalRequestContinuation(approvalRequest) ??
			buildLoopApprovalContinuation({
				request: approvalRequest,
				approvedBy: session.user.id,
			});

		return NextResponse.json({
			approvalRequest: {
				...approvalRequest,
				toolInput: sanitizeReplayToolInput(approvalRequest.toolInput),
			},
			continuationPreview: {
				...continuationPreview,
				toolInput: sanitizeReplayToolInput(continuationPreview.toolInput),
				replayConfirmationToken: replayConfirmationRequired(
					continuationPreview.capability,
				)
					? buildLoopApprovalReplayConfirmationToken(continuationPreview)
					: null,
			},
		});
	} catch (error) {
		console.error("[LoopApprovals] GET detail error:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to read loop approval",
			},
			{ status: 500 },
		);
	}
}

export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const session=await auth();if(!session?.user?.id)return new Response("Unauthorized",{status:401});
  if(request.headers.has("X-Work-Actor")&&request.headers.get("X-Work-Actor")!==session.user.id)return NextResponse.json({error:"actor_changed"},{status:409});
  const {id}=await params,body=await request.json().catch(()=>null);
  if(!body||typeof body!=="object"||Array.isArray(body)||!isResolvableStatus(body.status)||"actionPayload" in body)return NextResponse.json({error:"invalid_command"},{status:400});
  return NextResponse.json(await resolveLoopApprovalCommand({userId:session.user.id,approvalRequestId:id,status:body.status,resolutionNote:body.resolutionNote}));
 }catch(error){
  const status=error instanceof WorkCommandConflict?error.status:500;
  return NextResponse.json({error:error instanceof Error?error.message:"Approval failed",...(error instanceof WorkCommandConflict?{code:error.code}:{})},{status});
 }
}
