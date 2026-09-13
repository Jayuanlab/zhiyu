import { auth } from "@/app/(auth)/auth";
import { getWorkCommand } from "@/lib/work-runtime/command-ledger";
import {listWorkCommandAudit} from "@/lib/work-runtime/command-audit";
import { NextResponse } from "next/server";

export async function GET(_request: Request, context: {params: Promise<{id: string; commandId: string}>}) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({error: "Unauthorized"}, {status: 401});
  const {id, commandId} = await context.params;
  const receipt = await getWorkCommand(session.user.id, commandId);
  if (!receipt || receipt.workId !== id) return NextResponse.json({error: "Not found"}, {status: 404});
  return NextResponse.json({command: receipt, events: await listWorkCommandAudit(session.user.id, commandId)});
}
